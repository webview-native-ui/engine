package io.github.webview_native_ui.engine

import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.Window
import android.webkit.WebView
import java.lang.ref.WeakReference
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
    private var pendingInput: MutableList<MotionEvent>? = null
    private var replaying = false
    private var nativeOwner: WeakReference<View>? = null

    private fun resolveContact(event: MotionEvent): Boolean? {
        if (replaying || contacts.isEmpty() || event.actionMasked != MotionEvent.ACTION_DOWN)
            return null
        val batch = mutableListOf(MotionEvent.obtain(event))
        pendingInput = batch
        var handled = true
        val expired = Runnable {
            if (pendingInput === batch) {
                pendingInput = null
                batch.forEach { it.recycle() }
                changed(false)
            }
        }
        root.postDelayed(expired, 1000)
        var remaining = 1
        var accepted = true
        fun completed(success: Boolean) {
            if (pendingInput !== batch) return
            accepted = accepted && success
            remaining--
            if (remaining != 0) return
            pendingInput = null
            root.removeCallbacks(expired)
            replaying = true
            try {
                if (accepted) batch.forEach { handled = dispatchTouchEvent(it) }
            } finally {
                replaying = false
                batch.forEach { it.recycle() }
            }
        }
        var claimed = false
        contacts.values.toList().forEach { contact ->
            remaining++
            if (contact(event, ::completed)) claimed = true else completed(true)
        }
        if (!claimed) {
            pendingInput = null
            root.removeCallbacks(expired)
            batch.forEach { it.recycle() }
            return null
        }
        completed(true)
        return handled
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
        pendingInput?.let {
            it.add(MotionEvent.obtain(event))
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
            pendingInput?.forEach { it.recycle() }
            pendingInput = null
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
                    if (window.callback === observer) window.callback = observer.previous
                    if (observers[window]?.get() === observer) observers.remove(window)
                }
            }
        }
    }
}
