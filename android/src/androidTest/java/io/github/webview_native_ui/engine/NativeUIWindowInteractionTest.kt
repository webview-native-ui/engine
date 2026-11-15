package io.github.webview_native_ui.engine

import android.content.Intent
import android.os.SystemClock
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.Button
import android.widget.FrameLayout
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class NativeUIWindowInteractionTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private lateinit var activity: EngineTestActivity
    private lateinit var first: Button
    private lateinit var second: Button
    private var stop: (() -> Unit)? = null
    private val taps = intArrayOf(0, 0)
    private val longs = intArrayOf(0, 0)
    private val contacts = intArrayOf(0, 0)

    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)

    @After
    fun close() {
        if (::activity.isInitialized)
            main {
                stop?.invoke()
                activity.finish()
            }
    }

    private fun fixture(delay: Long, detector: Boolean = false) {
        activity =
            instrumentation.startActivitySync(
                Intent(instrumentation.targetContext, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        main {
            fun button(index: Int) =
                Button(activity).apply {
                    text = "SDK $index"
                    setOnClickListener { taps[index]++ }
                    setOnLongClickListener {
                        longs[index]++
                        true
                    }
                    if (detector) {
                        val gestures =
                            GestureDetector(
                                activity,
                                object : GestureDetector.SimpleOnGestureListener() {
                                    override fun onDown(event: MotionEvent) = true

                                    override fun onSingleTapUp(event: MotionEvent): Boolean {
                                        taps[index]++
                                        return true
                                    }

                                    override fun onLongPress(event: MotionEvent) {
                                        longs[index]++
                                    }
                                },
                            )
                        setOnTouchListener { _, event ->
                            gestures.onTouchEvent(event)
                            true
                        }
                    }
                    activity.root.addView(
                        this,
                        FrameLayout.LayoutParams(200, 200).apply {
                            leftMargin = index * 200
                            topMargin = 80
                        },
                    )
                    visibility = View.INVISIBLE
                }
            first = button(0)
            second = button(1)
            stop =
                NativeUIWindowInteraction.observe(
                    activity.window,
                    contact = { event, complete ->
                        val origin = IntArray(2)
                        first.getLocationOnScreen(origin)
                        val index = if (event.rawX < origin[0] + 200) 0 else 1
                        contacts[index]++
                        activity.root.postDelayed(
                            {
                                (if (index == 0) first else second).visibility = View.VISIBLE
                                complete(true)
                            },
                            delay,
                        )
                        true
                    },
                ) {}
        }
        instrumentation.waitForIdleSync()
    }

    private fun send(view: View, action: Int, down: Long): Boolean {
        var handled = false
        main {
            val origin = IntArray(2)
            view.getLocationInWindow(origin)
            val event =
                MotionEvent.obtain(
                    down,
                    SystemClock.uptimeMillis(),
                    action,
                    origin[0] + 100f,
                    origin[1] + 100f,
                    0,
                )
            try {
                handled = activity.window.callback.dispatchTouchEvent(event)
            } finally {
                event.recycle()
            }
        }
        return handled
    }

    private fun touch(view: View, duration: Long) {
        val down = SystemClock.uptimeMillis()
        assertTrue(send(view, MotionEvent.ACTION_DOWN, down))
        Thread.sleep(duration)
        send(view, MotionEvent.ACTION_UP, down)
    }

    private fun awaitActions(expected: Int) {
        val deadline = SystemClock.uptimeMillis() + 3000
        var actual = 0
        while (actual < expected && SystemClock.uptimeMillis() < deadline) {
            main { actual = taps.sum() + longs.sum() }
            if (actual < expected) Thread.sleep(10)
        }
        assertEquals(expected, actual)
    }

    @Test
    fun nativeButtonLongPressSurvivesPartialBuffering() {
        fixture(200)
        touch(first, ViewConfiguration.getLongPressTimeout() + 100L)
        awaitActions(1)
        main {
            assertEquals(1, longs[0])
            assertEquals(0, taps[0])
        }
    }

    @Test
    fun nativeButtonLongPressSurvivesFullyBufferedGesture() {
        fixture(ViewConfiguration.getLongPressTimeout() + 200L)
        touch(first, ViewConfiguration.getLongPressTimeout() + 100L)
        awaitActions(1)
        main {
            assertEquals(1, longs[0])
            assertEquals(0, taps[0])
        }
    }

    @Test
    fun gestureDetectorShortTapDoesNotBecomeLongAfterSlowRestore() {
        fixture(ViewConfiguration.getLongPressTimeout() + 200L, detector = true)
        touch(first, 40)
        awaitActions(1)
        main {
            assertEquals(1, taps[0])
            assertEquals(0, longs[0])
        }
    }

    @Test
    fun gestureDetectorLongPressSurvivesSlowRestore() {
        fixture(ViewConfiguration.getLongPressTimeout() + 200L, detector = true)
        touch(first, ViewConfiguration.getLongPressTimeout() + 100L)
        awaitActions(1)
        main {
            assertEquals(1, longs[0])
            assertEquals(0, taps[0])
        }
    }

    @Test
    fun focusLossCancelsAnAlreadyDeliveredDown() {
        fixture(50)
        val down = SystemClock.uptimeMillis()
        assertTrue(send(first, MotionEvent.ACTION_DOWN, down))
        Thread.sleep(150)
        main {
            assertTrue(first.isPressed)
            activity.window.callback.onWindowFocusChanged(false)
        }
        Thread.sleep(ViewConfiguration.getLongPressTimeout() + 100L)
        send(first, MotionEvent.ACTION_UP, down)
        main {
            assertFalse(first.isPressed)
            assertEquals(0, taps[0])
            assertEquals(0, longs[0])
        }
    }

    @Test
    fun followingGestureResolvesItsOwnPhotoContact() {
        fixture(200)
        touch(first, 20)
        touch(second, 20)
        awaitActions(2)
        main {
            assertArrayEquals(intArrayOf(1, 1), contacts)
            assertArrayEquals(intArrayOf(1, 1), taps)
            assertArrayEquals(intArrayOf(0, 0), longs)
        }
    }

    @Test
    fun removingObserverCancelsAnAlreadyDeliveredDown() {
        fixture(50)
        val down = SystemClock.uptimeMillis()
        send(first, MotionEvent.ACTION_DOWN, down)
        Thread.sleep(150)
        main {
            assertTrue(first.isPressed)
            stop?.invoke()
            stop = null
        }
        Thread.sleep(ViewConfiguration.getLongPressTimeout() + 100L)
        send(first, MotionEvent.ACTION_UP, down)
        main {
            assertFalse(first.isPressed)
            assertEquals(0, taps[0])
            assertEquals(0, longs[0])
        }
    }
}
