package io.github.webview_native_ui.engine

import android.content.Intent
import android.graphics.RectF
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.Button
import android.widget.FrameLayout
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeUIContactCaptureTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)

    @Test fun visualInvalidationRetainsPendingContactAndNativeTap() = verify(false)

    @Test fun sourceInvalidationCancelsPendingContactWithoutDroppingNativeTap() = verify(true)

    @Test fun captureTimeoutPreservesNativeTap() = verify(false, true)

    @Test fun requestArmedDuringWebGestureSurvivesToNativeContact() = verify(false, false, true)

    @Test fun contactAcquisitionPreservesNativeLongPress() = verify(false, longPress = true)

    @Test fun releasedPixelsAreNotSelectedByLaterContact() = verify(false, release = true)

    private fun verify(
        cancel: Boolean,
        stall: Boolean = false,
        duringGesture: Boolean = false,
        longPress: Boolean = false,
        release: Boolean = false,
    ) {
        val activity =
            instrumentation.startActivitySync(
                Intent(instrumentation.targetContext, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        lateinit var snapshots: NativeUISnapshots
        lateinit var button: Button
        val done = CountDownLatch(1)
        val clicked = CountDownLatch(1)
        val clickedAfterRelease = CountDownLatch(1)
        var tapCount = 0
        var longCount = 0
        val selected = mutableListOf<JSONObject>()
        var result = JSONObject()
        var callbackBeforePress = false
        try {
            main {
                if (stall) {
                    val previous = activity.web
                    activity.root.removeView(previous)
                    previous.destroy()
                    activity.web =
                        object : android.webkit.WebView(activity) {
                            override fun postVisualStateCallback(
                                id: Long,
                                callback: VisualStateCallback,
                            ) {}
                        }
                    activity.root.addView(activity.web, FrameLayout.LayoutParams(-1, -1))
                }
                snapshots =
                    NativeUISnapshots(File(activity.cacheDir, "contact-${System.nanoTime()}"))
                button =
                    Button(activity).apply {
                        text = "SDK button"
                        setOnClickListener {
                            tapCount++
                            clicked.countDown()
                            if (tapCount == 2) clickedAfterRelease.countDown()
                        }
                        setOnLongClickListener {
                            longCount++
                            clicked.countDown()
                            true
                        }
                    }
                activity.root.addView(
                    button,
                    FrameLayout.LayoutParams(220, 90).apply {
                        leftMargin = 30
                        topMargin = 180
                    },
                )
                snapshots.observeInteractions(activity.window) { event ->
                    if (event.has("captureID")) {
                        selected.add(event)
                        callbackBeforePress = !button.isPressed
                    }
                }
            }
            instrumentation.waitForIdleSync()
            if (!stall) {
                val painted = CountDownLatch(1)
                main {
                    activity.web.postVisualStateCallback(
                        0,
                        object : android.webkit.WebView.VisualStateCallback() {
                            override fun onComplete(id: Long) {
                                activity.web.postOnAnimation {
                                    activity.web.postOnAnimation {
                                        activity.web.post { painted.countDown() }
                                    }
                                }
                            }
                        },
                    )
                }
                assertTrue("Fixture Web draw did not complete", painted.await(5, TimeUnit.SECONDS))
            }
            val request =
                JSONObject()
                    .put("action", "prepare")
                    .put("ids", JSONArray().put("sdk"))
                    .put("revision", 1)
                    .put("viewportWidth", activity.web.width)
                    .put("captureID", "contact")
                    .put("captureOwner", "owner")
                    .put("captureDelayMs", 10000)
                    .put("stopScrollBeforeCapture", true)
            fun send(request: JSONObject, complete: (JSONObject) -> Unit = {}) {
                snapshots.handle(
                    request,
                    activity.window,
                    activity.web,
                    frames = { _, _ ->
                        mapOf(
                            "sdk" to
                                RectF(
                                    button.x,
                                    button.y,
                                    button.x + button.width,
                                    button.y + button.height,
                                )
                        )
                    },
                    views = { listOf(button) },
                ) {
                    complete(it.getOrThrow())
                }
            }
            main {
                if (duringGesture) snapshots.interaction(true)
                send(request) {
                    result = it
                    done.countDown()
                }
                repeat(5) {
                    send(
                        JSONObject()
                            .put("action", "change")
                            .put("captureOwner", "owner")
                            .put("retainPending", true)
                    )
                }
                button.x = 60f
                if (cancel) send(JSONObject().put("action", "change").put("captureOwner", "owner"))
                if (duringGesture) snapshots.interaction(false)
                val time = SystemClock.uptimeMillis()
                val location = IntArray(2)
                button.getLocationOnScreen(location)
                val root = IntArray(2)
                activity.window.decorView.getLocationOnScreen(root)
                for ((action, at) in
                    listOf(
                        MotionEvent.ACTION_DOWN to time,
                        MotionEvent.ACTION_UP to
                            time +
                                (if (longPress)
                                    android.view.ViewConfiguration.getLongPressTimeout() + 100
                                else 40),
                    )) {
                    val event =
                        MotionEvent.obtain(
                            time,
                            at,
                            action,
                            location[0] - root[0] + 20f,
                            location[1] - root[1] + 20f,
                            0,
                        )
                    activity.window.callback.dispatchTouchEvent(event)
                    event.recycle()
                }
            }
            assertTrue("Capture did not complete", done.await(10, TimeUnit.SECONDS))
            assertTrue("SDK tap was lost", clicked.await(3, TimeUnit.SECONDS))
            assertEquals(if (longPress) 0 else 1, tapCount)
            assertEquals(if (longPress) 1 else 0, longCount)
            if (cancel || stall) {
                assertFalse(result.has("token"))
                assertTrue(selected.isEmpty())
            } else {
                assertTrue("No immutable pixels", result.has("token"))
                assertEquals(1, selected.size)
                assertEquals("contact", selected.single().getString("captureID"))
                assertTrue("Captured SDK pressed state", callbackBeforePress)
                assertEquals(
                    48.0,
                    result.getJSONArray("parts").getJSONObject(0).getDouble("x"),
                    1.0,
                )
            }
            if (release) {
                main {
                    snapshots.release(result.getString("token"))
                    selected.clear()
                    val time = SystemClock.uptimeMillis()
                    for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                        val event =
                            MotionEvent.obtain(time, time, action, button.x + 20, button.y + 20, 0)
                        activity.window.callback.dispatchTouchEvent(event)
                        event.recycle()
                    }
                    assertTrue("Released capture selected by later contact", selected.isEmpty())
                }
                assertTrue(
                    "SDK tap lost after release",
                    clickedAfterRelease.await(3, TimeUnit.SECONDS),
                )
                assertEquals(2, tapCount)
            }
        } finally {
            main {
                snapshots.close()
                activity.finish()
            }
        }
    }
}
