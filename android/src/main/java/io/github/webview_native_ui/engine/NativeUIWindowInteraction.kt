package io.github.webview_native_ui.engine

import android.view.MotionEvent
import android.view.Window
import android.view.ViewConfiguration
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/** One non-consuming observer per window; preserve the application's callback chain. */
internal class NativeUIWindowInteraction private constructor(
    private val previous: Window.Callback,
    private val touchSlop: Int
) : Window.Callback by previous {
    private val listeners = linkedSetOf<(Boolean) -> Unit>()
    internal data class Drag(val downX: Float, val downY: Float, val dx: Float, val dy: Float)
    private val dragListeners = linkedMapOf<(Boolean) -> Unit, (Drag) -> Unit>()
    private var downX = 0f
    private var downY = 0f
    private var dragReported = false
    private var active = false

    private fun changed(value: Boolean) {
        if (active == value) return
        active = value
        listeners.toList().forEach { it(value) }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            downX = event.rawX; downY = event.rawY; dragReported = false
            changed(true)
        }
        if (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN) dragReported = true
        if (active && !dragReported && event.actionMasked == MotionEvent.ACTION_MOVE && event.pointerCount == 1) {
            val dx = event.rawX - downX; val dy = event.rawY - downY
            if (dx * dx + dy * dy > touchSlop.toFloat() * touchSlop) {
                dragReported = true
                // Before WebView consumes this MOVE: its compositor must not move the
                // prepared underlay while a live native view still occupies the old position.
                dragListeners.values.toList().forEach { it(Drag(downX, downY, dx, dy)) }
            }
        }
        var handled = false
        try {
            handled = previous.dispatchTouchEvent(event)
            return handled
        } finally {
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL ||
                (event.actionMasked == MotionEvent.ACTION_DOWN && !handled)) changed(false)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        if (!hasFocus) changed(false)
        previous.onWindowFocusChanged(hasFocus)
    }

    companion object {
        private val observers = WeakHashMap<Window, WeakReference<NativeUIWindowInteraction>>()
        fun observe(window: Window, drag: ((Drag) -> Unit)? = null, listener: (Boolean) -> Unit): () -> Unit {
            check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
            val observer = observers[window]?.get() ?: NativeUIWindowInteraction(requireNotNull(window.callback), ViewConfiguration.get(window.context).scaledTouchSlop).also {
                observers[window] = WeakReference(it)
                window.callback = it
            }
            observer.listeners.add(listener)
            if (drag != null) observer.dragListeners[listener] = drag
            listener(observer.active)
            return {
                observer.listeners.remove(listener)
                observer.dragListeners.remove(listener)
                if (observer.listeners.isEmpty()) {
                    if (window.callback === observer) window.callback = observer.previous
                    if (observers[window]?.get() === observer) observers.remove(window)
                }
            }
        }
    }
}
