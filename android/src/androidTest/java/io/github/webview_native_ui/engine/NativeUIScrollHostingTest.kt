package io.github.webview_native_ui.engine

import android.content.Intent
import android.graphics.RectF
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class NativeUIScrollHostingTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)

    private lateinit var activity: EngineTestActivity
    private lateinit var button: Button
    private lateinit var host: NativeUIScrollHosting
    private lateinit var clipped: NativeUIClippedView
    private var projection: NativeUIProjection? = null
    private var firstWebMove: (() -> Unit)? = null
    private var softwareDraws = 0
    private var sdkDownTime = 0L
    private var taps = 0
    private var longs = 0
    private var scale = 1f
    private var cssWidth = 0f

    @After
    fun close() {
        if (::activity.isInitialized)
            main {
                projection?.close()
                activity.finish()
            }
    }

    private fun js(expression: String): String {
        val done = CountDownLatch(1)
        var result = ""
        main {
            activity.web.evaluateJavascript(expression) {
                result = it
                done.countDown()
            }
        }
        assertTrue("JavaScript response: $expression", done.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun load(kind: String = "overflow") {
        activity =
            instrumentation.startActivitySync(
                Intent(instrumentation.targetContext, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        val loaded = CountDownLatch(1)
        val feed =
            when (kind) {
                "body" ->
                    "<div style='height:6000px;background:linear-gradient(white,blue)'>Article</div><script>var feed=document.scrollingElement;</script>"
                "shadow" ->
                    """<ion-content id="shell" style="position:absolute;left:20px;top:80px;width:calc(100% - 40px);height:500px"></ion-content><script>
                var root=document.getElementById('shell').attachShadow({mode:'open'});
                root.innerHTML='<div id="feed" style="height:500px;overflow:auto"><div style="height:6000px;background:linear-gradient(white,blue)">Article</div></div>';
                var feed=root.getElementById('feed');</script>"""
                else ->
                    """<div id="feed" style="position:absolute;left:20px;top:80px;width:calc(100% - 40px);height:500px;overflow:auto"><div style="height:6000px;background:linear-gradient(white,blue)">Article</div></div><script>var feed=document.getElementById('feed');</script>"""
            }
        main {
            activity.web.webViewClient =
                object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        if (url == "https://localhost/scroll-host") loaded.countDown()
                    }
                }
            activity.web.loadDataWithBaseURL(
                "https://localhost/scroll-host",
                """
                <meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style>$feed
                <script>var webClicks=0,webLongs=0;document.addEventListener('click',function(){webClicks++});document.addEventListener('contextmenu',function(){webLongs++});</script>
            """
                    .trimIndent(),
                "text/html",
                "utf-8",
                null,
            )
        }
        assertTrue("Scroll document did not load", loaded.await(20, TimeUnit.SECONDS))
        assertTrue(js("feed.scrollHeight").toInt() >= 6000)
        cssWidth = js("innerWidth").toFloat()
        main {
            scale = activity.web.width / cssWidth
            button =
                object : Button(activity) {
                        override fun draw(canvas: android.graphics.Canvas) {
                            if (!canvas.isHardwareAccelerated) softwareDraws++
                            super.draw(canvas)
                        }
                    }
                    .apply {
                        text = "Native SDK"
                        setOnTouchListener { _, event ->
                            if (event.actionMasked == MotionEvent.ACTION_DOWN)
                                sdkDownTime = event.downTime
                            false
                        }
                        setOnClickListener { taps++ }
                        setOnLongClickListener {
                            longs++
                            true
                        }
                    }
            host = NativeUIScrollHosting(activity.web, button)
            clipped = NativeUIClippedView(host)
            activity.root.addView(clipped, FrameLayout.LayoutParams(1, 1))
            clipped.place(
                RectF(20 * scale, 80 * scale, (20 + (cssWidth - 40) / 2) * scale, 580 * scale),
                RectF(20 * scale, 80 * scale, (cssWidth - 20) * scale, 580 * scale),
            )
            activity.web.setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_MOVE) {
                    val check = firstWebMove
                    firstWebMove = null
                    check?.invoke()
                }
                false
            }
        }
        val visual = CountDownLatch(1)
        main {
            activity.web.postVisualStateCallback(
                1,
                object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        visual.countDown()
                    }
                },
            )
        }
        assertTrue("Scroll document did not draw", visual.await(10, TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
    }

    private fun send(action: Int, x: Float, y: Float, downTime: Long, eventTime: Long) {
        val origin = IntArray(2)
        val windowOrigin = IntArray(2)
        activity.web.getLocationOnScreen(origin)
        activity.window.decorView.getLocationOnScreen(windowOrigin)
        val properties =
            MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        val coordinates =
            MotionEvent.PointerCoords().apply {
                this.x = origin[0] + x * scale
                this.y = origin[1] + y * scale
                pressure = 1f
                size = 1f
            }
        val event =
            MotionEvent.obtain(
                downTime,
                eventTime,
                action,
                1,
                arrayOf(properties),
                arrayOf(coordinates),
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_TOUCHSCREEN,
                0,
            )
        event.offsetLocation(-windowOrigin[0].toFloat(), -windowOrigin[1].toFloat())
        try {
            assertTrue(activity.window.callback.dispatchTouchEvent(event))
        } finally {
            event.recycle()
        }
    }

    private fun fling(native: Boolean, distance: Float = 264f) {
        main {
            // Replay a timed stream through the real Window/View hierarchy. InputManager
            // test injections wait on transactions and distort the release velocity.
            val end = SystemClock.uptimeMillis()
            val start = end - 120
            val x = cssWidth * if (native) .25f else .75f
            send(MotionEvent.ACTION_DOWN, x, 460f, start, start)
            for (step in 1..12) send(
                MotionEvent.ACTION_MOVE,
                x,
                460f - step * distance / 12,
                start,
                start + step * 9,
            )
            send(MotionEvent.ACTION_UP, x, 460f - distance, start, end)
        }
    }

    private fun touch(native: Boolean, long: Boolean = false, y: Float = 300f): Long {
        val down = SystemClock.uptimeMillis()
        val x = cssWidth * if (native) .25f else .75f
        main { send(MotionEvent.ACTION_DOWN, x, y, down, down) }
        if (long) Thread.sleep(ViewConfiguration.getLongPressTimeout().toLong() + 100)
        main { send(MotionEvent.ACTION_UP, x, y, down, SystemClock.uptimeMillis()) }
        return down
    }

    private fun position() = js("feed.scrollTop").toFloat()

    private fun assertMoving() {
        Thread.sleep(80)
        val before = position()
        Thread.sleep(80)
        val after = position()
        assertTrue("Expected actual WebView inertia: $before -> $after", after > before + 10)
    }

    private fun assertStopped() {
        Thread.sleep(80)
        val stopped = position()
        Thread.sleep(180)
        assertEquals("The contacted scroll owner must remain stationary", stopped, position(), 1f)
    }

    private fun callbacks(clicks: Int, longPresses: Int) {
        main {
            assertEquals(clicks, taps)
            assertEquals(longPresses, longs)
        }
        assertEquals("No Web click may replace an SDK click", "0", js("webClicks"))
        assertEquals("No Web long press may replace an SDK long press", "0", js("webLongs"))
    }

    private fun projectedFixture() {
        org.junit.Assume.assumeTrue(
            androidx.webkit.WebViewFeature.isFeatureSupported(
                androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT
            )
        )
        load()
        js(
            """
            var slot=document.createElement('div'); slot.id='slot';slot.style.cssText='width:50%;height:250px';feed.prepend(slot);
            slot[Symbol.for('webview-native-ui-engine.projection-placement')]={projected:false,measure:()=>{
              var r=slot.getBoundingClientRect(),c=feed.getBoundingClientRect();
              return{x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,clip:{x:c.x,y:c.y,width:c.width,height:c.height}};
            },invalidate:()=>{}};
            window.testEvents={};window.Capacitor={addListener:(plugin,name,fn)=>{testEvents[name]=fn;return{remove:async()=>{delete testEvents[name]}}},convertFileSrc:url=>'https://localhost/_capacitor_file_'+url.replace('file://','')};
            """
                .trimIndent()
        )
        main {
            button.setBackgroundColor(android.graphics.Color.RED)
            clipped.place(
                RectF(20 * scale, 80 * scale, (20 + (cssWidth - 40) / 2) * scale, 330 * scale),
                RectF(20 * scale, 80 * scale, (cssWidth - 20) * scale, 580 * scale),
            )
            activity.web.webViewClient =
                object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: android.webkit.WebResourceRequest,
                    ): android.webkit.WebResourceResponse? {
                        val path = request.url.path ?: return null
                        if (!path.startsWith("/_capacitor_file_")) return null
                        val file = File(path.removePrefix("/_capacitor_file_"))
                        if (!file.canonicalPath.startsWith(activity.cacheDir.canonicalPath + "/"))
                            return null
                        return android.webkit.WebResourceResponse(
                            "image/png",
                            null,
                            file.inputStream(),
                        )
                    }
                }
            projection =
                NativeUIProjection(
                    activity.window,
                    activity.web,
                    "Fixture",
                    "#slot",
                    captureMode = NativeUIProjection.CaptureMode.VIEW,
                    updatePlacement = { value ->
                        val clip = value.getJSONObject("clip")
                        fun rect(raw: JSONObject) =
                            RectF(
                                (raw.getDouble("x") * scale).toFloat(),
                                (raw.getDouble("y") * scale).toFloat(),
                                ((raw.getDouble("x") + raw.getDouble("width")) * scale).toFloat(),
                                ((raw.getDouble("y") + raw.getDouble("height")) * scale).toFloat(),
                            )
                        clipped.place(rect(value), rect(clip))
                    },
                    view = { button },
                )
        }
        val ready =
            NativeUIProjection::class.java.getDeclaredField("latestReadyToken").apply {
                isAccessible = true
            }
        val deadline = SystemClock.uptimeMillis() + 10000
        var prepared = false
        while (!prepared && SystemClock.uptimeMillis() < deadline) {
            main { prepared = ready.get(projection) != null }
            if (!prepared) Thread.sleep(20)
        }
        assertTrue("Opaque image must be decoded and drawn before the gesture", prepared)
    }

    @Test
    fun imageOwnsPixelsBeforeNativeDragAndSamePhotoTapReachesSDK() {
        photoContact(false)
    }

    @Test
    fun firstPhotoLongPressReachesSDKWithOriginalTiming() {
        photoContact(true)
    }

    private fun photoContact(longPress: Boolean) {
        projectedFixture()
        var moveObserved = false
        val captures = softwareDraws
        main {
            firstWebMove = {
                moveObserved = true
                assertTrue(projection!!.isProjecting)
                assertEquals(View.INVISIBLE, button.visibility)
                assertEquals("No capture on the scroll hot path", captures, softwareDraws)
            }
        }
        // A short native drag keeps part of the advertisement in the viewport.
        main {
            val end = SystemClock.uptimeMillis()
            val start = end - 120
            val x = cssWidth * .25f
            send(MotionEvent.ACTION_DOWN, x, 270f, start, start)
            for (step in 1..12) send(
                MotionEvent.ACTION_MOVE,
                x,
                270f - step * 40f / 12,
                start,
                start + step * 9,
            )
            send(MotionEvent.ACTION_UP, x, 230f, start, end)
        }
        assertTrue(moveObserved)
        main { assertTrue(projection!!.isProjecting) }
        // The original DOWN/UP is retained across fresh placement and native draw.
        val originalDown = touch(true, long = longPress, y = 120f)
        val deadline = SystemClock.uptimeMillis() + 2000
        var clicked = false
        while (!clicked && SystemClock.uptimeMillis() < deadline) {
            main { clicked = if (longPress) longs == 1 else taps == 1 }
            if (!clicked) Thread.sleep(10)
        }
        val geometry =
            js(
                "JSON.stringify({scroll:feed.scrollTop,slot:slot.getBoundingClientRect().toJSON(),webClicks,webLongs})"
            )
        var nativeState = ""
        main {
            val location = IntArray(2)
            button.getLocationOnScreen(location)
            nativeState =
                "projecting=${projection!!.isProjecting} visibility=${button.visibility} sdkDown=$sdkDownTime original=$originalDown location=${location.toList()} size=${button.width}x${button.height}"
        }
        assertTrue(
            "The first photo contact must perform the real SDK click: $nativeState $geometry",
            clicked,
        )
        callbacks(if (longPress) 0 else 1, if (longPress) 1 else 0)
        assertStopped()
        main {
            assertEquals(originalDown, sdkDownTime)
            assertFalse(projection!!.isProjecting)
            assertEquals(View.VISIBLE, button.visibility)
        }
    }

    @Test
    fun nativeTapAndLongPressNeverReachWeb() {
        load()
        touch(true)
        touch(true, long = true)
        callbacks(1, 1)
    }

    @Test
    fun nativeDragScrollsRealOverflowAndArticleContactStopsIt() {
        load()
        fling(true)
        assertMoving()
        touch(false)
        assertStopped()
        main {
            assertEquals(0, taps)
            assertEquals(0, longs)
        }
    }

    @Test
    fun webFlingStopsOnNativeTapAndNextNativeDragResumes() {
        load()
        fling(false)
        assertMoving()
        touch(true)
        assertStopped()
        callbacks(1, 0)
        val before = position()
        fling(true)
        assertMoving()
        assertTrue(position() > before + 100)
    }

    @Test
    fun webFlingStopsOnNativeLongPress() {
        load()
        fling(false)
        assertMoving()
        touch(true, long = true)
        assertStopped()
        callbacks(0, 1)
    }

    @Test
    fun nativeDragScrollsBody() {
        load("body")
        fling(true)
        assertMoving()
        callbacks(0, 0)
    }

    @Test
    fun nativeDragScrollsShadowOverflow() {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 26)
        load("shadow")
        fling(true)
        assertMoving()
        callbacks(0, 0)
    }
}
