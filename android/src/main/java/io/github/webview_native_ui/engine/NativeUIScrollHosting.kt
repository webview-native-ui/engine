package io.github.webview_native_ui.engine

import android.annotation.SuppressLint
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.webkit.WebView
import android.widget.FrameLayout

/** SDK taps stay native; only a drag is handed to the WebView's own scroll recognizer. */
@SuppressLint("ViewConstructor")
class NativeUIScrollHosting(private val webView: WebView, content: View) :
    FrameLayout(content.context) {
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var down: MotionEvent? = null
    private var dragging = false

    init {
        addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            reset()
            NativeUIWindowInteraction.nativeTouch(this, true)
            if (
                webView.isAttachedToWindow &&
                    webView.windowToken === windowToken &&
                    translationOnly(this) &&
                    translationOnly(webView)
            ) {
                down = MotionEvent.obtain(event)
                // Let Chromium observe this contact without starting a second gesture.
                // Older WebViews do not cancel DOM-overflow inertia with flingScroll(0, 0).
                val contact = MotionEvent.obtain(event)
                val origin = IntArray(2)
                webView.getLocationOnScreen(origin)
                try {
                    contact.setLocation(event.rawX - origin[0], event.rawY - origin[1])
                    webView.onTouchEvent(contact)
                    contact.action = MotionEvent.ACTION_CANCEL
                    webView.onTouchEvent(contact)
                } finally {
                    contact.recycle()
                }
            }
        } else if (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN && !dragging) {
            // A native multi-touch gesture cannot become a feed drag later.
            down?.recycle()
            down = null
        }
        try {
            return super.dispatchTouchEvent(event)
        } finally {
            if (
                event.actionMasked == MotionEvent.ACTION_UP ||
                    event.actionMasked == MotionEvent.ACTION_CANCEL
            )
                reset()
        }
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (!beginDrag(event)) return false
        forward(event)
        return true
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (down == null) return super.onTouchEvent(event)
        if (beginDrag(event)) forward(event)
        return true
    }

    private fun beginDrag(event: MotionEvent): Boolean {
        if (dragging) return true
        val start = down ?: return false
        if (
            event.actionMasked != MotionEvent.ACTION_MOVE ||
                event.pointerCount != 1 ||
                event.eventTime - start.eventTime >= ViewConfiguration.getLongPressTimeout()
        )
            return false
        val dx = event.rawX - start.rawX
        val dy = event.rawY - start.rawY
        if (dx * dx + dy * dy <= touchSlop.toFloat() * touchSlop) return false
        dragging = true
        parent?.requestDisallowInterceptTouchEvent(true)
        NativeUIWindowInteraction.beforeNativeScroll(
            this,
            NativeUIWindowInteraction.Drag(start.rawX, start.rawY, dx, dy, webView),
        )
        forward(start)
        return true
    }

    private fun forward(event: MotionEvent) {
        if (!webView.isAttachedToWindow) return
        val origin = IntArray(2)
        webView.getLocationOnScreen(origin)
        val copy = MotionEvent.obtain(event)
        try {
            copy.setLocation(event.rawX - origin[0], event.rawY - origin[1])
            webView.dispatchTouchEvent(copy)
        } finally {
            copy.recycle()
        }
    }

    private fun reset() {
        NativeUIWindowInteraction.nativeTouch(this, false)
        down?.recycle()
        down = null
        dragging = false
    }

    override fun onDetachedFromWindow() {
        if (dragging && webView.isAttachedToWindow) {
            val now = SystemClock.uptimeMillis()
            val cancel =
                MotionEvent.obtain(down?.downTime ?: now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
            try {
                webView.dispatchTouchEvent(cancel)
            } finally {
                cancel.recycle()
            }
        }
        reset()
        super.onDetachedFromWindow()
    }

    internal companion object {
        fun owns(view: View, webView: WebView): Boolean =
            generateSequence(view) { it.parent as? View }
                .filterIsInstance<NativeUIScrollHosting>()
                .any { it.webView === webView }
    }

    private fun translationOnly(view: View): Boolean =
        generateSequence(view) { it.parent as? View }
            .all {
                it.scaleX == 1f &&
                    it.scaleY == 1f &&
                    it.rotation == 0f &&
                    it.rotationX == 0f &&
                    it.rotationY == 0f
            }
}
