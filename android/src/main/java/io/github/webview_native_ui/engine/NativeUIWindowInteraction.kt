package io.github.webview_native_ui.engine

import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.Window
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.util.ArrayDeque
import java.util.WeakHashMap

/** Preserve the callback chain and original input across a native image handoff. */
internal class NativeUIWindowInteraction
private constructor(
    private val previous: Window.Callback,
    private val touchSlop: Int,
    private val root: View,
) : Window.Callback by previous {
    private val listeners = linkedSetOf<(Boolean) -> Unit>()

    internal data class Drag(
        val downX: Float,
        val downY: Float,
        val dx: Float,
        val dy: Float,
        val nativeWebView: WebView? = null,
    )

    private val contacts =
        linkedMapOf<(Boolean) -> Unit, (MotionEvent, (Boolean) -> Unit) -> Boolean>()

    private class InputReplay(event: MotionEvent) {
        val events = ArrayDeque<MotionEvent>().apply { add(MotionEvent.obtain(event)) }
        var shift = 0L
        var contactResolved = false
        var task: Runnable? = null
        var timeout: Runnable? = null
        var delivered: MotionEvent? = null
    }

    private var pendingInput: InputReplay? = null
    private var replaying = false
    private var nativeOwner: WeakReference<View>? = null

    private fun resolveContact(event: MotionEvent): Boolean? {
        if (replaying || contacts.isEmpty() || event.actionMasked != MotionEvent.ACTION_DOWN)
            return null
        val input = InputReplay(event)
        pendingInput = input
        if (resolveContact(input)) return true
        pendingInput = null
        input.events.removeFirst().recycle()
        return null
    }

    // Resolve each DOWN independently, including gestures queued behind another return.
    private fun resolveContact(input: InputReplay): Boolean {
        val event = input.events.first
        val expired = Runnable { cancelInput(input) }
        input.timeout = expired
        root.postDelayed(expired, 1000)
        var remaining = 1
        var accepted = true
        fun completed(success: Boolean) {
            if (pendingInput !== input) return
            accepted = accepted && success
            remaining--
            if (remaining != 0) return
            root.removeCallbacks(expired)
            input.timeout = null
            if (!accepted) {
                cancelInput(input)
                return
            }
            input.contactResolved = true
            // Both native View timers and GestureDetector deadlines must see the
            // same gesture duration. Shift delivery and event timestamps together.
            input.shift = maxOf(input.shift, SystemClock.uptimeMillis() - event.eventTime)
            replay(input)
        }
        var claimed = false
        contacts.values.toList().forEach { contact ->
            remaining++
            if (contact(event, ::completed)) claimed = true else completed(true)
        }
        if (!claimed) {
            root.removeCallbacks(expired)
            input.timeout = null
            input.contactResolved = true
            return false
        }
        completed(true)
        return true
    }

    private fun replay(input: InputReplay) {
        if (pendingInput !== input || input.timeout != null || input.task != null) return
        val event = input.events.peekFirst() ?: return
        if (event.actionMasked == MotionEvent.ACTION_DOWN && !input.contactResolved) {
            if (resolveContact(input)) return
        }
        val task = Runnable {
            input.task = null
            if (pendingInput !== input) return@Runnable
            val original = input.events.removeFirst()
            val copy = shifted(original, input.shift)
            val ended =
                copy.actionMasked == MotionEvent.ACTION_UP ||
                    copy.actionMasked == MotionEvent.ACTION_CANCEL
            input.delivered?.recycle()
            input.delivered = if (ended) null else MotionEvent.obtain(copy)
            if (ended) input.contactResolved = false
            replaying = true
            try {
                dispatchTouchEvent(copy)
            } finally {
                replaying = false
                original.recycle()
                copy.recycle()
            }
            if (pendingInput !== input) return@Runnable
            if (ended && input.events.isEmpty()) pendingInput = null else replay(input)
        }
        val delay = event.eventTime + input.shift - SystemClock.uptimeMillis()
        if (delay <= 0) task.run()
        else {
            input.task = task
            root.postDelayed(task, delay)
        }
    }

    private fun cancelInput(input: InputReplay? = pendingInput) {
        if (input == null || pendingInput !== input) return
        pendingInput = null
        input.task?.let { root.removeCallbacks(it) }
        input.timeout?.let { root.removeCallbacks(it) }
        input.events.forEach { it.recycle() }
        input.events.clear()
        input.delivered?.let { event ->
            event.action = MotionEvent.ACTION_CANCEL
            replaying = true
            try {
                dispatchTouchEvent(event)
            } finally {
                replaying = false
                event.recycle()
            }
        }
        input.delivered = null
        changed(false)
    }

    private fun shifted(event: MotionEvent, shift: Long): MotionEvent {
        val properties =
            Array(event.pointerCount) { index ->
                MotionEvent.PointerProperties().also { event.getPointerProperties(index, it) }
            }
        val coords = Array(event.pointerCount) { MotionEvent.PointerCoords() }
        val offsetX = event.rawX - event.x
        val offsetY = event.rawY - event.y
        fun coordinates(history: Int) {
            coords.forEachIndexed { index, point ->
                if (history < event.historySize)
                    event.getHistoricalPointerCoords(index, history, point)
                else event.getPointerCoords(index, point)
                point.x += offsetX
                point.y += offsetY
            }
        }
        fun time(history: Int) =
            (if (history < event.historySize) event.getHistoricalEventTime(history)
            else event.eventTime) + shift
        coordinates(0)
        val copy =
            if (Build.VERSION.SDK_INT >= 34)
                MotionEvent.obtain(
                    event.downTime + shift,
                    time(0),
                    event.action,
                    event.pointerCount,
                    properties,
                    coords,
                    event.metaState,
                    event.buttonState,
                    event.xPrecision,
                    event.yPrecision,
                    event.deviceId,
                    event.edgeFlags,
                    event.source,
                    root.display?.displayId ?: 0,
                    event.flags,
                    event.classification,
                )!!
            else
                MotionEvent.obtain(
                    event.downTime + shift,
                    time(0),
                    event.action,
                    event.pointerCount,
                    properties,
                    coords,
                    event.metaState,
                    event.buttonState,
                    event.xPrecision,
                    event.yPrecision,
                    event.deviceId,
                    event.edgeFlags,
                    event.source,
                    event.flags,
                )
        for (history in 1..event.historySize) {
            coordinates(history)
            copy.addBatch(time(history), coords, event.metaState)
        }
        copy.offsetLocation(-offsetX, -offsetY)
        return copy
    }

    private val dragListeners = linkedMapOf<(Boolean) -> Unit, (Drag) -> Unit>()
    private var downX = 0f
    private var downY = 0f
    private var dragReported = false
    private var active = false

    private fun changed(value: Boolean) {
        if (active == value) return
        active = value
        if (!value) nativeOwner = null
        listeners.toList().forEach { it(value) }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (!replaying)
            pendingInput?.let {
                it.events.add(MotionEvent.obtain(event))
                replay(it)
                return true
            }
        resolveContact(event)?.let {
            return it
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            downX = event.rawX
            downY = event.rawY
            dragReported = false
            changed(true)
        }
        if (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN) dragReported = true
        if (
            active &&
                !dragReported &&
                event.actionMasked == MotionEvent.ACTION_MOVE &&
                event.pointerCount == 1
        ) {
            val dx = event.rawX - downX
            val dy = event.rawY - downY
            if (dx * dx + dy * dy > touchSlop.toFloat() * touchSlop) {
                dragReported = true
                // Before WebView consumes this MOVE: its compositor must not move the
                // prepared underlay while a live native view still occupies the old position.
                if (nativeOwner?.get() == null)
                    dragListeners.values.toList().forEach { it(Drag(downX, downY, dx, dy)) }
            }
        }
        var handled = false
        try {
            handled = previous.dispatchTouchEvent(event)
            return handled
        } finally {
            if (
                event.actionMasked == MotionEvent.ACTION_UP ||
                    event.actionMasked == MotionEvent.ACTION_CANCEL ||
                    (event.actionMasked == MotionEvent.ACTION_DOWN && !handled)
            )
                changed(false)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        if (!hasFocus) {
            cancelInput()
            changed(false)
            nativeOwner = null
        }
        previous.onWindowFocusChanged(hasFocus)
    }

    companion object {
        private val observers = WeakHashMap<Window, WeakReference<NativeUIWindowInteraction>>()

        private fun observer(view: View): NativeUIWindowInteraction? =
            observers.entries
                .firstOrNull { it.key.decorView.windowToken === view.windowToken }
                ?.value
                ?.get()

        fun nativeTouch(view: View, active: Boolean) {
            val observer = observer(view) ?: return
            if (active) observer.nativeOwner = WeakReference(view)
            else if (observer.nativeOwner?.get() === view) observer.nativeOwner = null
        }

        fun beforeNativeScroll(view: View, drag: Drag) {
            observer(view)?.dragListeners?.values?.toList()?.forEach { it(drag) }
        }

        fun observe(
            window: Window,
            drag: ((Drag) -> Unit)? = null,
            contact: ((MotionEvent, (Boolean) -> Unit) -> Boolean)? = null,
            listener: (Boolean) -> Unit,
        ): () -> Unit {
            check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
            val observer =
                observers[window]?.get()
                    ?: NativeUIWindowInteraction(
                            requireNotNull(window.callback),
                            ViewConfiguration.get(window.context).scaledTouchSlop,
                            window.decorView,
                        )
                        .also {
                            observers[window] = WeakReference(it)
                            window.callback = it
                        }
            observer.listeners.add(listener)
            if (drag != null) observer.dragListeners[listener] = drag
            if (contact != null) observer.contacts[listener] = contact
            listener(observer.active)
            return {
                observer.listeners.remove(listener)
                observer.dragListeners.remove(listener)
                observer.contacts.remove(listener)
                if (observer.listeners.isEmpty()) {
                    observer.cancelInput()
                    if (window.callback === observer) window.callback = observer.previous
                    if (observers[window]?.get() === observer) observers.remove(window)
                }
            }
        }
    }
}
