package io.github.webview_native_ui.engine

import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.RectF
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeUIEngineTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)

    private fun activity(): EngineTestActivity {
        val context = instrumentation.targetContext
        val activity =
            instrumentation.startActivitySync(
                Intent(context, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        instrumentation.waitForIdleSync()
        val deadline = System.currentTimeMillis() + 5000
        var ready = false
        while (!ready && System.currentTimeMillis() < deadline) {
            val done = CountDownLatch(1)
            main {
                activity.web.evaluateJavascript(
                    "document.readyState==='complete' && document.body?.textContent.includes('Web content')"
                ) {
                    ready = it == "true"
                    done.countDown()
                }
            }
            assertTrue(done.await(2, TimeUnit.SECONDS))
            if (!ready) Thread.sleep(10)
        }
        assertTrue("Web fixture did not finish loading", ready)
        return activity
    }

    @Test
    fun requestHandoffRejectsMalformedFramesAndUsesCurrentDestination() {
        val activity = activity()
        lateinit var snapshots: NativeUISnapshots
        lateinit var native: View
        fun send(request: JSONObject): JSONObject {
            val done = CountDownLatch(1)
            var result: Result<JSONObject>? = null
            main {
                snapshots.handle(
                    request,
                    activity.window,
                    activity.web,
                    frames = { ids, revision ->
                        if (ids == setOf("button") && revision == 7L)
                            mapOf("button" to RectF(20f, 120f, 180f, 184f))
                        else emptyMap()
                    },
                    views = { ids -> if (ids == setOf("button")) listOf(native) else null },
                ) {
                    result = it
                    done.countDown()
                }
            }
            assertTrue(done.await(10, TimeUnit.SECONDS))
            return result!!.getOrThrow()
        }
        try {
            main {
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                activity.root.addView(
                    native,
                    FrameLayout.LayoutParams(160, 64).apply {
                        leftMargin = 20
                        topMargin = 120
                    },
                )
                snapshots =
                    NativeUISnapshots(File(activity.cacheDir, "protocol-${System.nanoTime()}"))
            }
            instrumentation.waitForIdleSync()
            val capture =
                send(
                    JSONObject()
                        .put("action", "prepare")
                        .put("ids", org.json.JSONArray().put("button"))
                        .put("revision", 7)
                        .put("viewportWidth", activity.web.width / 2.0)
                )
            val token = capture.getString("token")
            val part = capture.getJSONArray("parts").getJSONObject(0)
            part.put("y", part.getDouble("y") + 30)
            val request =
                JSONObject()
                    .put("action", "cover")
                    .put("token", token)
                    .put("viewportWidth", activity.web.width / 2.0)
                    .put("parts", org.json.JSONArray().put(part))
            val invalid =
                JSONObject(request.toString())
                    .put("parts", org.json.JSONArray().put(part).put(part))
            assertFalse(send(invalid).getBoolean("shown"))
            main { assertEquals(View.VISIBLE, native.visibility) }
            assertTrue(send(request).getBoolean("shown"))
            main {
                assertEquals(View.INVISIBLE, native.visibility)
                val root = activity.window.decorView
                val pixels =
                    android.graphics.Bitmap.createBitmap(
                        root.width,
                        root.height,
                        android.graphics.Bitmap.Config.ARGB_8888,
                    )
                root.draw(android.graphics.Canvas(pixels))
                val origin = IntArray(2)
                val rootOrigin = IntArray(2)
                activity.web.getLocationInWindow(origin)
                root.getLocationInWindow(rootOrigin)
                assertEquals(
                    "Entry image must be painted at its new destination",
                    Color.RED,
                    pixels.getPixel(
                        origin[0] - rootOrigin[0] + 100,
                        origin[1] - rootOrigin[1] + 220,
                    ),
                )
                pixels.recycle()
            }
            send(JSONObject().put("action", "painted").put("token", token))
            assertTrue(
                send(JSONObject(request.toString()).put("action", "restore")).getBoolean("shown")
            )
            main {
                snapshots.restoreViews()
                assertEquals(View.VISIBLE, native.visibility)
            }
            send(JSONObject().put("action", "restored").put("token", token))
            send(JSONObject().put("action", "release").put("token", token))
            assertFalse(send(request).getBoolean("shown"))
            main { assertEquals(View.VISIBLE, native.visibility) }
        } finally {
            main {
                snapshots.close()
                activity.finish()
            }
        }
    }

    @Test
    fun cordovaNotificationsAndLifecycleDoNotReachUntrustedNavigation() {
        org.junit.Assume.assumeTrue(
            androidx.webkit.WebViewFeature.isFeatureSupported(
                androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT
            )
        )
        val activity = activity()
        var registration: NativeUIProjection? = null
        fun js(source: String): String {
            val done = CountDownLatch(1)
            var result = ""
            main {
                activity.web.evaluateJavascript(source) {
                    result = it
                    done.countDown()
                }
            }
            assertTrue(done.await(5, TimeUnit.SECONDS))
            return result
        }
        fun waitFor(source: String) {
            val deadline = System.currentTimeMillis() + 5000
            while (System.currentTimeMillis() < deadline) {
                if (js(source) == "true") return
                Thread.sleep(20)
            }
            fail("Timed out: $source")
        }
        val spy =
            "window.calls=[];window.WebViewNativeUIEngineRuntime={start:async()=>{},notify:(...a)=>calls.push(a),receive:(...a)=>calls.push(a),hide:(...a)=>{calls.push(a);return true},show:(...a)=>calls.push(a),stop:(...a)=>calls.push(a)}"
        try {
            js(spy)
            main {
                registration =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#slot",
                        receiveListeners =
                            NativeUIProjection.ReceiveListeners(update = listOf("updated")),
                        runtime = NativeUIProjection.Runtime.CORDOVA,
                        view = { null },
                    )
            }
            main { registration!!.receive("updated", JSONObject().put("value", "private")) }
            waitFor("calls.some(args=>args[1]==='updated' && args[2].value==='private')")
            val allowed = CountDownLatch(1)
            var accepted = false
            main {
                registration!!.hide {
                    accepted = it
                    allowed.countDown()
                }
            }
            assertTrue(allowed.await(5, TimeUnit.SECONDS))
            assertTrue(accepted)
            main {
                activity.web.loadDataWithBaseURL(
                    "https://untrusted.example",
                    "<body><script>$spy</script></body>",
                    "text/html",
                    "utf-8",
                    null,
                )
            }
            waitFor("location.host==='untrusted.example' && typeof calls!=='undefined'")
            main { registration!!.receive("updated", JSONObject().put("value", "private")) }
            assertEquals("0", js("calls.length"))
            val denied = CountDownLatch(1)
            accepted = true
            main {
                registration!!.hide {
                    accepted = it
                    denied.countDown()
                }
                registration!!.show()
                registration!!.close()
            }
            assertTrue(denied.await(5, TimeUnit.SECONDS))
            assertFalse(accepted)
            assertEquals("0", js("calls.length"))
        } finally {
            main {
                registration?.close()
                activity.finish()
            }
        }
    }

    @Test
    fun placementChangesPositionWithoutResettingDimensionsAndClipsInput() {
        val activity = activity()
        try {
            main {
                val child = TextView(activity)
                val container = NativeUIClippedView(child)
                activity.root.addView(container, FrameLayout.LayoutParams(1, 1))
                assertTrue(container.place(RectF(20f, 20f, 180f, 100f), RectF(0f, 60f, 300f, 500f)))
                assertEquals(40, container.layoutParams.height)
                assertEquals(80, child.layoutParams.height)
                assertEquals(-40f, child.y, 0.1f)
                val containerParams = container.layoutParams
                val contentParams = child.layoutParams
                assertTrue(container.place(RectF(20f, 30f, 180f, 110f), RectF(0f, 70f, 300f, 500f)))
                assertSame(containerParams, container.layoutParams)
                assertSame(contentParams, child.layoutParams)
                val touches = mutableListOf<Boolean>()
                container.interaction = { touches.add(it) }
                val down =
                    android.view.MotionEvent.obtain(
                        0,
                        0,
                        android.view.MotionEvent.ACTION_DOWN,
                        1f,
                        1f,
                        0,
                    )
                assertFalse(container.dispatchTouchEvent(down))
                down.recycle()
                assertEquals(listOf(true, false), touches)
                assertFalse(
                    container.place(RectF(20f, -100f, 180f, -20f), RectF(0f, 0f, 300f, 500f))
                )
                assertEquals(View.INVISIBLE, container.visibility)
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun unsupportedCaptureKeepsNativeViewOnApi23() {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT < 26)
        val context = instrumentation.targetContext
        val activity =
            instrumentation.startActivitySync(
                Intent(context, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        try {
            main {
                val native = View(activity)
                native.setBackgroundColor(Color.RED)
                activity.root.addView(native, FrameLayout.LayoutParams(100, 40))
                val snapshots = NativeUISnapshots(File(activity.cacheDir, "unsupported"))
                assertFalse(snapshots.supported)
                var completed = false
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    400.0,
                    { mapOf("view" to RectF(0f, 0f, 100f, 40f)) },
                ) {
                    assertFalse(it.has("token"))
                    completed = true
                }
                assertTrue(completed)
                assertEquals(View.VISIBLE, native.visibility)
                snapshots.close()
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun viewPixelsExcludeOccludingContentAndPadding() {
        val activity = activity()
        lateinit var snapshots: NativeUISnapshots
        lateinit var native: View
        try {
            main {
                val parent = FrameLayout(activity)
                parent.clipChildren = true
                activity.root.addView(
                    parent,
                    FrameLayout.LayoutParams(160, 32).apply {
                        leftMargin = 20
                        topMargin = 120
                    },
                )
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                parent.addView(native, FrameLayout.LayoutParams(160, 64).apply { topMargin = -32 })
                snapshots = NativeUISnapshots(File(activity.cacheDir, "view-${System.nanoTime()}"))
            }
            instrumentation.waitForIdleSync()
            val ready = CountDownLatch(1)
            var result = JSONObject()
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    activity.web.width.toDouble(),
                    { mapOf("ad" to RectF(20f, 88f, 180f, 152f)) },
                    sourceViews = { mapOf("ad" to native) },
                ) {
                    result = it
                    ready.countDown()
                }
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            assertTrue(result.has("token"))
            val part = result.getJSONArray("parts").getJSONObject(0)
            assertEquals(160, part.getInt("width"))
            assertEquals(64, part.getInt("height"))
            val image = BitmapFactory.decodeFile(File(java.net.URI(part.getString("url"))).path)
            for (y in 0 until image.height) for (x in 0 until image.width) assertEquals(
                Color.RED,
                image.getPixel(x, y),
            )
            image.recycle()
            val original = File(java.net.URI(part.getString("url")))
            fun prepareAgain(revision: Long): JSONObject {
                val done = CountDownLatch(1)
                var value = JSONObject()
                main {
                    snapshots.prepare(
                        activity.window,
                        activity.web,
                        activity.web.width.toDouble(),
                        { mapOf("ad" to RectF(20f, 188f, 180f, 252f)) },
                        sourceViews = { mapOf("ad" to native) },
                        contentRevision = revision,
                    ) {
                        value = it
                        done.countDown()
                    }
                }
                assertTrue(done.await(10, TimeUnit.SECONDS))
                return value
            }
            main { snapshots.release(result.getString("token")) }
            val moved = prepareAgain(0)
            assertEquals(
                part.getString("url"),
                moved.getJSONArray("parts").getJSONObject(0).getString("url"),
            )
            assertEquals(188, moved.getJSONArray("parts").getJSONObject(0).getInt("y"))
            main { snapshots.release(moved.getString("token")) }
            // App-private cache files can be evicted without any appearance change.
            assertTrue(original.delete())
            val recovered = prepareAgain(0)
            val recoveredFile =
                File(
                    java.net.URI(recovered.getJSONArray("parts").getJSONObject(0).getString("url"))
                )
            assertTrue("A missing cached PNG must be captured again", recoveredFile.isFile)
            val recoveredImage = BitmapFactory.decodeFile(recoveredFile.path)
            assertNotNull(recoveredImage)
            assertEquals(Color.RED, recoveredImage.getPixel(0, 0))
            recoveredImage.recycle()
            main { snapshots.release(recovered.getString("token")) }
            val changed = prepareAgain(1)
            assertNotEquals(
                part.getString("url"),
                changed.getJSONArray("parts").getJSONObject(0).getString("url"),
            )
            assertFalse(original.exists())
            val changedFile =
                File(java.net.URI(changed.getJSONArray("parts").getJSONObject(0).getString("url")))
            main { snapshots.reset() }
            assertFalse(changedFile.exists())
            val newDocument = prepareAgain(1)
            assertNotEquals(
                changedFile.toURI().toString(),
                newDocument.getJSONArray("parts").getJSONObject(0).getString("url"),
            )
            main { snapshots.close() }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun expiredEntryCopyRestoresNativeAndRejectsLatePaint() {
        val activity = activity()
        lateinit var snapshots: NativeUISnapshots
        lateinit var native: View
        try {
            main {
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                activity.root.addView(native, FrameLayout.LayoutParams(100, 40))
                snapshots =
                    NativeUISnapshots(File(activity.cacheDir, "expiry-${System.nanoTime()}"))
            }
            val ready = CountDownLatch(1)
            var token = ""
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    activity.web.width.toDouble(),
                    { mapOf("view" to RectF(0f, 0f, 100f, 40f)) },
                    sourceViews = { mapOf("view" to native) },
                ) {
                    token = it.optString("token")
                    ready.countDown()
                }
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            assertTrue(token.isNotEmpty())
            main {
                assertTrue(
                    snapshots.cover(
                        token,
                        activity.window,
                        activity.web,
                        listOf(native),
                        transient = true,
                    )
                )
                assertEquals(View.INVISIBLE, native.visibility)
            }
            Thread.sleep(650)
            main {
                assertEquals(View.VISIBLE, native.visibility)
                var completed = false
                snapshots.retireCopyAfterWebDraw(token, activity.web) {
                    assertFalse(it)
                    completed = true
                }
                assertTrue(completed)
                var rejected = false
                snapshots.handle(
                    JSONObject().put("action", "painted").put("token", token),
                    activity.window,
                    activity.web,
                    frames = { _, _ -> emptyMap() },
                    views = { listOf(native) },
                ) {
                    rejected = it.isFailure
                }
                assertTrue(
                    "Expired paint must reject the bridge request so Web abandons its image",
                    rejected,
                )
                snapshots.close()
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun compositedPixelsArePreparedThenCoveredAndRestoredWithoutRecapture() {
        val activity = activity()
        lateinit var snapshots: NativeUISnapshots
        lateinit var native: View
        try {
            main {
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                activity.root.addView(
                    native,
                    FrameLayout.LayoutParams(160, 64).apply {
                        leftMargin = 20
                        topMargin = 120
                    },
                )
                snapshots =
                    NativeUISnapshots(File(activity.cacheDir, "engine-${System.nanoTime()}"))
            }
            instrumentation.waitForIdleSync()
            Thread.sleep(100)
            val ready = CountDownLatch(1)
            var result = JSONObject()
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    activity.web.width.toDouble(),
                    { mapOf("button" to RectF(20f, 120f, 180f, 184f)) },
                ) {
                    result = it
                    ready.countDown()
                }
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            assertTrue(result.has("token"))
            val token = result.getString("token")
            val part = result.getJSONArray("parts").getJSONObject(0)
            val file = File(java.net.URI(part.getString("url")))
            assertTrue(file.exists())
            val image = BitmapFactory.decodeFile(file.path)
            assertEquals(Color.RED, image.getPixel(14, 14))
            image.recycle()
            val foregroundReady = CountDownLatch(1)
            var foreground = ""
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    activity.web.width.toDouble(),
                    { mapOf("button" to RectF(20f, 120f, 180f, 184f)) },
                ) {
                    foreground = it.optString("token")
                    foregroundReady.countDown()
                }
            }
            assertTrue(foregroundReady.await(10, TimeUnit.SECONDS))
            assertTrue(foreground.isNotEmpty())
            main {
                assertFalse(
                    snapshots.cover("missing", activity.window, activity.web, listOf(native))
                )
                assertEquals(View.VISIBLE, native.visibility)
                assertTrue(snapshots.cover(token, activity.window, activity.web, listOf(native)))
                assertTrue(
                    snapshots.cover(
                        foreground,
                        activity.window,
                        activity.web,
                        listOf(native),
                        transient = true,
                    )
                )
                assertEquals(token, snapshots.coveringToken)
                snapshots.release(foreground)
                assertEquals(token, snapshots.coveringToken)
                assertTrue(snapshots.cover(token, activity.window, activity.web, listOf(native)))
                assertEquals(View.INVISIBLE, native.visibility)
                snapshots.retireCopy("stale")
                assertTrue(snapshots.hidesNativeViews)
                snapshots.retireCopy(token)
                snapshots.restoreViews()
                assertEquals(View.VISIBLE, native.visibility)
                assertFalse(
                    snapshots.restore(
                        token,
                        activity.window,
                        activity.web,
                        mapOf("button" to RectF(20f, 120f, 190f, 184f)),
                    )
                )
                assertTrue(
                    snapshots.restore(
                        token,
                        activity.window,
                        activity.web,
                        mapOf("button" to RectF(8f, 108f, 192f, 196f)),
                    )
                )
                snapshots.retireCopy(token, entry = false)
                snapshots.release(token)
                assertFalse(file.exists())
                assertFalse(snapshots.cover(token, activity.window, activity.web, listOf(native)))
                snapshots.interaction(true)
                snapshots.reset()
            }
            val recovered = CountDownLatch(1)
            var recoveredToken: String? = null
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    activity.web.width.toDouble(),
                    { mapOf("button" to RectF(20f, 120f, 180f, 184f)) },
                ) {
                    recoveredToken = it.optString("token").takeIf(String::isNotEmpty)
                    recovered.countDown()
                }
            }
            assertTrue(recovered.await(5, TimeUnit.SECONDS))
            assertNotNull(recoveredToken)
            main { snapshots.close() }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun translucentContentKeepsCompositedPixelsAcrossWebHandoffAndReturn() {
        val activity = activity()
        lateinit var native: View
        lateinit var snapshots: NativeUISnapshots
        fun script(code: String): String {
            val done = CountDownLatch(1)
            var value = ""
            main {
                activity.web.evaluateJavascript(code) {
                    value = it
                    done.countDown()
                }
            }
            assertTrue(done.await(5, TimeUnit.SECONDS))
            return value
        }
        fun webReady() {
            val done = CountDownLatch(1)
            var accepted = false
            main {
                NativeUIWebReadiness.prepare(activity.web, { true }) {
                    accepted = it
                    done.countDown()
                }
            }
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertTrue(accepted)
        }
        try {
            script(
                "document.body.style.background='repeating-linear-gradient(90deg, rgb(40,80,120) 0px 20px, rgb(180,160,60) 20px 40px)'"
            )
            webReady()
            main {
                native = View(activity)
                native.setBackgroundColor(Color.argb(128, 220, 30, 80))
                activity.root.addView(
                    native,
                    FrameLayout.LayoutParams(160, 64).apply {
                        leftMargin = 20
                        topMargin = 120
                    },
                )
                snapshots =
                    NativeUISnapshots(File(activity.cacheDir, "translucent-${System.nanoTime()}"))
            }
            instrumentation.waitForIdleSync()
            Thread.sleep(100)
            val viewport = script("innerWidth").toDouble()
            val prepared = CountDownLatch(1)
            var response = JSONObject()
            main {
                snapshots.prepare(
                    activity.window,
                    activity.web,
                    viewport,
                    { mapOf("control" to RectF(20f, 120f, 180f, 184f)) },
                ) {
                    response = it
                    prepared.countDown()
                }
            }
            assertTrue(prepared.await(5, TimeUnit.SECONDS))
            assertTrue(response.has("token"))
            val token = response.getString("token")
            val part = response.getJSONArray("parts").getJSONObject(0)
            val file = File(java.net.URI(part.getString("url")))
            val baseline = BitmapFactory.decodeFile(file.path)
            val data =
                android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
            script(
                """window.proxy=document.createElement('img');proxy.src='data:image/png;base64,$data';proxy.style.cssText='position:fixed;visibility:hidden;pointer-events:none;left:${part.getDouble("x")}px;top:${part.getDouble("y")}px;width:${part.getDouble("width")}px;height:${part.getDouble("height")}px';document.body.append(proxy);window.decoded=false;proxy.decode().then(()=>window.decoded=true)"""
            )
            repeat(50) { if (script("window.decoded") != "true") Thread.sleep(10) }
            assertEquals("true", script("window.decoded"))
            webReady()
            // Sample actual composited window frames throughout both transfers, not just endpoints.
            val samples =
                java.util.Collections.synchronizedList(mutableListOf<android.graphics.Bitmap>())
            val running = java.util.concurrent.atomic.AtomicBoolean(true)
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val pending = java.util.concurrent.atomic.AtomicInteger()
            lateinit var capture: Runnable
            capture = Runnable {
                if (running.get()) {
                    val origin = IntArray(2)
                    activity.web.getLocationInWindow(origin)
                    val rect =
                        android.graphics.Rect(
                            origin[0] + 8,
                            origin[1] + 108,
                            origin[0] + 192,
                            origin[1] + 196,
                        )
                    val pixels =
                        android.graphics.Bitmap.createBitmap(
                            184,
                            88,
                            android.graphics.Bitmap.Config.ARGB_8888,
                        )
                    pending.incrementAndGet()
                    android.view.PixelCopy.request(
                        activity.window,
                        rect,
                        pixels,
                        { result ->
                            if (result == android.view.PixelCopy.SUCCESS) samples.add(pixels)
                            else pixels.recycle()
                            pending.decrementAndGet()
                            if (running.get()) handler.postDelayed(capture, 16)
                        },
                        handler,
                    )
                }
            }
            main { handler.post(capture) }
            repeat(3) {
                main {
                    assertTrue(
                        snapshots.cover(token, activity.window, activity.web, listOf(native))
                    )
                }
                script("proxy.style.visibility='visible'")
                webReady()
                main { snapshots.retireCopy(token) }
                Thread.sleep(120)
                main {
                    assertTrue(
                        snapshots.restore(
                            token,
                            activity.window,
                            activity.web,
                            mapOf("control" to RectF(8f, 108f, 192f, 196f)),
                        )
                    )
                    snapshots.restoreViews()
                }
                script("proxy.style.visibility='hidden'")
                webReady()
                main {
                    snapshots.retireCopy(token, entry = false)
                    snapshots.finishCovering()
                }
                Thread.sleep(120)
            }
            running.set(false)
            main { handler.removeCallbacks(capture) }
            repeat(50) { if (pending.get() > 0) Thread.sleep(10) }
            assertEquals(0, pending.get())
            assertTrue("Expected continuous samples, got ${samples.size}", samples.size >= 12)
            var maxDelta = 0
            for (image in samples) {
                // Interior + surrounding background; skip only the outer PixelCopy crop edge.
                for (y in 2 until 86) for (x in 2 until 182) {
                    val expected = baseline.getPixel(x, y)
                    val actual = image.getPixel(x, y)
                    for (shift in listOf(0, 8, 16)) maxDelta =
                        maxOf(
                            maxDelta,
                            kotlin.math.abs(
                                ((expected shr shift) and 255) - ((actual shr shift) and 255)
                            ),
                        )
                }
                image.recycle()
            }
            android.util.Log.i(
                "NativeUIEngineTest",
                "Translucent handoff: ${samples.size} frames, max channel delta $maxDelta",
            )
            baseline.recycle()
            assertTrue("Composited color changed: max channel delta $maxDelta", maxDelta <= 2)
            main { snapshots.close() }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun webReadinessRejectsInvalidatedPreparation() {
        val activity = activity()
        try {
            val ready = CountDownLatch(1)
            var accepted = false
            main {
                NativeUIWebReadiness.prepare(activity.web, { true }) {
                    accepted = it
                    ready.countDown()
                }
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            assertTrue(accepted)
            val stale = CountDownLatch(1)
            var current = true
            var staleAccepted = true
            main {
                NativeUIWebReadiness.prepare(activity.web, { current }) {
                    staleAccepted = it
                    stale.countDown()
                }
                current = false
            }
            assertTrue(stale.await(5, TimeUnit.SECONDS))
            assertFalse(staleAccepted)
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun windowInteractionSharesObserversAndPreservesCallbackOwnership() {
        val activity = activity()
        try {
            main {
                val window = activity.window
                val original = window.callback
                var dispatched = 0
                val previous =
                    object : android.view.Window.Callback by original {
                        override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
                            dispatched++
                            return true
                        }
                    }
                window.callback = previous
                val first = mutableListOf<Boolean>()
                val second = mutableListOf<Boolean>()
                val stopFirst = NativeUIWindowInteraction.observe(window) { first.add(it) }
                val observer = window.callback
                val stopSecond = NativeUIWindowInteraction.observe(window) { second.add(it) }
                assertSame(observer, window.callback)
                fun touch(action: Int) {
                    val now = android.os.SystemClock.uptimeMillis()
                    val event = android.view.MotionEvent.obtain(now, now, action, 1f, 1f, 0)
                    assertTrue(window.callback.dispatchTouchEvent(event))
                    event.recycle()
                }
                touch(android.view.MotionEvent.ACTION_DOWN)
                stopFirst()
                touch(android.view.MotionEvent.ACTION_CANCEL)
                assertEquals(listOf(false, true), first)
                assertEquals(listOf(false, true, false), second)
                touch(android.view.MotionEvent.ACTION_DOWN)
                window.callback.onWindowFocusChanged(false)
                assertEquals(listOf(false, true, false, true, false), second)
                val outer = object : android.view.Window.Callback by window.callback {}
                window.callback = outer
                stopSecond()
                assertSame(outer, window.callback)
                touch(android.view.MotionEvent.ACTION_UP)
                assertEquals(4, dispatched)
                assertEquals(listOf(false, true, false, true, false), second)
                window.callback = original
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun dragObservationPreservesTapsAndRunsBeforeTheConsumingMove() {
        val activity = activity()
        try {
            main {
                val window = activity.window
                val original = window.callback
                var moves = 0
                var drags = 0
                var otherDrags = 0
                window.callback =
                    object : android.view.Window.Callback by original {
                        override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
                            if (event.actionMasked == android.view.MotionEvent.ACTION_MOVE) {
                                moves++
                                if (moves == 2) {
                                    assertEquals(1, drags)
                                    assertEquals(1, otherDrags)
                                }
                            }
                            return true
                        }
                    }
                val stop = NativeUIWindowInteraction.observe(window, drag = { drags++ }) {}
                val stopOther =
                    NativeUIWindowInteraction.observe(window, drag = { otherDrags++ }) {}
                fun touch(action: Int, y: Float) {
                    val now = android.os.SystemClock.uptimeMillis()
                    val event = android.view.MotionEvent.obtain(now, now, action, 10f, y, 0)
                    assertTrue(window.callback.dispatchTouchEvent(event))
                    event.recycle()
                }
                touch(android.view.MotionEvent.ACTION_DOWN, 10f)
                touch(android.view.MotionEvent.ACTION_UP, 10f)
                assertEquals(0, drags)
                touch(android.view.MotionEvent.ACTION_DOWN, 10f)
                touch(android.view.MotionEvent.ACTION_MOVE, 11f)
                assertEquals(0, drags)
                touch(android.view.MotionEvent.ACTION_MOVE, 210f)
                touch(android.view.MotionEvent.ACTION_MOVE, 310f)
                assertEquals(1, drags)
                assertEquals(1, otherDrags)
                touch(android.view.MotionEvent.ACTION_CANCEL, 310f)
                stop()
                stopOther()
                window.callback = original
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun onlyReadyViewPixelsInTheDraggedScrollRegionCanCoverEarly() {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 26)
        val activity = activity()
        lateinit var registration: NativeUIProjection
        lateinit var native: View
        var capturable = true
        var clicks = 0
        val receive =
            NativeUIProjection::class
                .java
                .getDeclaredMethod("receive", JSONObject::class.java)
                .apply { isAccessible = true }
        val drag =
            NativeUIProjection::class
                .java
                .getDeclaredMethod("coverBeforeScroll", NativeUIWindowInteraction.Drag::class.java)
                .apply { isAccessible = true }
        val idField =
            NativeUIProjection::class.java.getDeclaredField("id").apply { isAccessible = true }
        val capturedField =
            NativeUIProjection::class.java.getDeclaredField("captured").apply {
                isAccessible = true
            }
        var seq = 0
        fun request(action: String, configure: (JSONObject) -> Unit = {}) {
            val payload = JSONObject().put("action", action)
            configure(payload)
            receive.invoke(
                registration,
                JSONObject()
                    .put("key", "${idField.get(registration)}:fixture:${++seq}")
                    .put("request", payload),
            )
        }
        try {
            val stubReady = CountDownLatch(1)
            main {
                activity.web.evaluateJavascript(
                    "globalThis.WebViewNativeUIEngineRuntime={start:async()=>{},receive:()=>{},stop:()=>{}}"
                ) {
                    stubReady.countDown()
                }
            }
            assertTrue(stubReady.await(3, TimeUnit.SECONDS))
            main {
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                native.setOnClickListener { clicks++ }
                activity.root.addView(
                    native,
                    FrameLayout.LayoutParams(100, 80).apply {
                        leftMargin = 80
                        topMargin = 100
                    },
                )
                registration =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#missing",
                        failedFallback = NativeUIProjection.FailedFallback.NATIVE,
                        captureMode = NativeUIProjection.CaptureMode.VIEW,
                        updatePlacement = {},
                        canCapture = { capturable },
                        view = { native },
                    )
                registration.awaitWebDraw = { _, current, done -> done(current()) }
            }
            instrumentation.waitForIdleSync()
            main {
                request("connect")
                val viewport =
                    JSONObject()
                        .put("x", 0)
                        .put("y", 0)
                        .put("width", activity.web.width)
                        .put("height", activity.web.height)
                request("track") {
                    it.put("viewportWidth", activity.web.width)
                        .put(
                            "gesture",
                            JSONObject()
                                .put("viewport", viewport)
                                .put("clip", viewport)
                                .put("offsetX", 0)
                                .put("offsetY", 100)
                                .put("rangeX", 0)
                                .put("rangeY", activity.web.height * 2),
                        )
                }
                val origin = IntArray(2)
                activity.web.getLocationOnScreen(origin)
                val vertical =
                    NativeUIWindowInteraction.Drag(origin[0] + 5f, origin[1] + 200f, 0f, -100f)
                drag.invoke(registration, vertical)
                assertEquals("Unprepared views stay native", View.VISIBLE, native.visibility)
                request("prepare") {
                    it.put("ids", org.json.JSONArray().put("view"))
                        .put("viewportWidth", activity.web.width)
                        .put("revision", 0)
                }
            }
            var token: String? = null
            val deadline = System.currentTimeMillis() + 10000
            while (token == null && System.currentTimeMillis() < deadline) {
                main {
                    token =
                        (capturedField.get(registration) as Map<*, *>).keys.firstOrNull() as? String
                }
                if (token == null) Thread.sleep(20)
            }
            assertNotNull("Fixture pixels were not captured", token)
            main {
                val origin = IntArray(2)
                activity.web.getLocationOnScreen(origin)
                drag.invoke(
                    registration,
                    NativeUIWindowInteraction.Drag(origin[0] + 5f, origin[1] + 200f, 0f, -100f),
                )
                assertEquals(
                    "Decoded/drawn acknowledgement is required",
                    View.VISIBLE,
                    native.visibility,
                )
                request("prepared") { it.put("token", token) }
                val location = IntArray(2)
                native.getLocationInWindow(location)
                val now = android.os.SystemClock.uptimeMillis()
                for (action in
                    listOf(
                        android.view.MotionEvent.ACTION_DOWN,
                        android.view.MotionEvent.ACTION_UP,
                    )) {
                    val event =
                        android.view.MotionEvent.obtain(
                            now,
                            now + 10,
                            action,
                            location[0] + 20f,
                            location[1] + 20f,
                            0,
                        )
                    activity.window.callback.dispatchTouchEvent(event)
                    event.recycle()
                }
            }
            instrumentation.waitForIdleSync()
            main { assertEquals("Prepared pixels must preserve the real native click", 1, clicks) }
            main {
                val origin = IntArray(2)
                activity.web.getLocationOnScreen(origin)
                val vertical =
                    NativeUIWindowInteraction.Drag(origin[0] + 5f, origin[1] + 200f, 0f, -100f)
                capturable = false
                drag.invoke(registration, vertical)
                assertEquals(View.VISIBLE, native.visibility)
                capturable = true
                drag.invoke(registration, vertical.copy(dx = -100f, dy = 0f))
                assertEquals(
                    "Horizontal motion cannot cover a vertical-only scroller",
                    View.VISIBLE,
                    native.visibility,
                )
                drag.invoke(registration, vertical.copy(downX = origin[0] - 10f))
                assertEquals(View.VISIBLE, native.visibility)
                val location = IntArray(2)
                native.getLocationOnScreen(location)
                drag.invoke(
                    registration,
                    vertical.copy(downX = location[0] + 5f, downY = location[1] + 5f),
                )
                assertEquals(
                    "A native input target retains its gesture",
                    View.VISIBLE,
                    native.visibility,
                )
                native.rotation = 45f
                drag.invoke(registration, vertical)
                assertEquals(
                    "Rotated native controls keep the existing input path",
                    View.VISIBLE,
                    native.visibility,
                )
                native.rotation = 0f
                activity.root.scaleX = 2f
                drag.invoke(registration, vertical)
                assertEquals(
                    "Transformed native ancestors keep the existing input path",
                    View.VISIBLE,
                    native.visibility,
                )
                activity.root.scaleX = 1f
                activity.web.scaleY = 2f
                drag.invoke(registration, vertical)
                assertEquals(
                    "Transformed WebView coordinates cannot start an early handoff",
                    View.VISIBLE,
                    native.visibility,
                )
                activity.web.scaleY = 1f
                drag.invoke(registration, vertical)
                assertEquals(View.INVISIBLE, native.visibility)
                assertTrue(registration.isProjecting)
                request("release") { it.put("token", token) }
                assertEquals(
                    "An unclaimed drag needs placement before retiring pixels",
                    View.INVISIBLE,
                    native.visibility,
                )
                request("release") { it.put("token", token).put("placement", JSONObject()) }
                assertEquals(View.VISIBLE, native.visibility)
                assertFalse(registration.isProjecting)
                drag.invoke(registration, vertical)
                assertEquals(
                    "Released tokens cannot hide the source",
                    View.VISIBLE,
                    native.visibility,
                )
            }
        } finally {
            main {
                registration.close()
                activity.finish()
            }
        }
    }

    @Test
    fun immediateHideAndClosePreserveRendererVisibility() {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 26)
        val activity = activity()
        val receive =
            NativeUIProjection::class
                .java
                .getDeclaredMethod("receive", JSONObject::class.java)
                .apply { isAccessible = true }
        val idField =
            NativeUIProjection::class.java.getDeclaredField("id").apply { isAccessible = true }
        val capturedField =
            NativeUIProjection::class.java.getDeclaredField("captured").apply {
                isAccessible = true
            }
        try {
            val ready = CountDownLatch(1)
            main {
                activity.web.evaluateJavascript(
                    "globalThis.WebViewNativeUIEngineRuntime={start:async()=>{},receive:()=>{},stop:()=>{}}"
                ) {
                    ready.countDown()
                }
            }
            assertTrue(ready.await(3, TimeUnit.SECONDS))
            for (image in listOf(false, true)) for (hidden in listOf(View.INVISIBLE, View.GONE)) {
                lateinit var registration: NativeUIProjection
                lateinit var native: View
                var current: View? = null
                var seq = 0
                fun request(payload: JSONObject) {
                    receive.invoke(
                        registration,
                        JSONObject()
                            .put("key", "${idField.get(registration)}:fixture:${++seq}")
                            .put("request", payload),
                    )
                }
                main {
                    native = View(activity)
                    native.setBackgroundColor(Color.RED)
                    activity.root.addView(
                        native,
                        FrameLayout.LayoutParams(100, 80).apply {
                            leftMargin = 80
                            topMargin = 100
                        },
                    )
                    current = native
                    registration =
                        NativeUIProjection(
                            activity.window,
                            activity.web,
                            "Fixture",
                            "#missing",
                            receiveListeners =
                                NativeUIProjection.ReceiveListeners(
                                    projection =
                                        NativeUIProjection.ReceiveListeners.Projection(
                                            none = listOf("hidden")
                                        )
                                ),
                            view = { current },
                        )
                }
                try {
                    instrumentation.waitForIdleSync()
                    if (image) {
                        main {
                            request(
                                JSONObject()
                                    .put("action", "prepare")
                                    .put("ids", org.json.JSONArray().put("view"))
                                    .put("viewportWidth", activity.web.width)
                            )
                        }
                        var token: String? = null
                        val deadline = System.currentTimeMillis() + 10000
                        while (token == null && System.currentTimeMillis() < deadline) {
                            main {
                                token =
                                    (capturedField.get(registration) as Map<*, *>)
                                        .keys
                                        .firstOrNull() as? String
                            }
                            Thread.sleep(20)
                        }
                        assertNotNull("Image must be prepared before covering", token)
                        main { request(JSONObject().put("action", "cover").put("token", token)) }
                    } else
                        main {
                            request(JSONObject().put("action", "visibility").put("visible", false))
                        }
                    main {
                        assertEquals(View.INVISIBLE, native.visibility)
                        native.visibility = hidden
                        current = null
                        registration.receive("hidden")
                        registration.close()
                        assertEquals(
                            "Close must preserve a hide before its Web acknowledgement (image=$image)",
                            hidden,
                            native.visibility,
                        )
                    }
                } finally {
                    main {
                        registration.close()
                        activity.root.removeView(native)
                    }
                }
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun compositedCaptureRejectsPlacementHandoff() {
        val activity = activity()
        try {
            main {
                try {
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#slot",
                        failedFallback = NativeUIProjection.FailedFallback.WEB,
                        captureMode = NativeUIProjection.CaptureMode.COMPOSITED,
                        updatePlacement = {},
                        view = { null },
                    )
                    fail("Composited capture must reject placement handoff")
                } catch (error: IllegalArgumentException) {
                    assertEquals("Placement handoff requires VIEW capture mode", error.message)
                }
            }
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun nativeInitializationOwnsImagesEventsAndTeardown() =
        nativeInitialization(NativeUIProjection.CaptureMode.COMPOSITED)

    @Test
    fun opaqueViewUsesPreparedWebPixelsWithoutNativeCopies() =
        nativeInitialization(NativeUIProjection.CaptureMode.VIEW)

    @Test
    fun lateOpaqueCoverCannotHideAfterResume() =
        nativeInitialization(NativeUIProjection.CaptureMode.VIEW, true)

    @Test
    fun invalidatedOpaqueImageAppliesPendingPlacementBeforeRelease() =
        nativeInitialization(NativeUIProjection.CaptureMode.VIEW, releaseWhileActive = true)

    @Test
    fun pressedWindowBlocksCaptureAcrossFirstConnection() =
        nativeInitialization(NativeUIProjection.CaptureMode.VIEW, pressOnConnect = true)

    @Test
    fun explicitPlacementIsNotOverwrittenByOlderImageFrame() =
        nativeInitialization(NativeUIProjection.CaptureMode.VIEW, authoritativePlacement = true)

    private fun nativeInitialization(
        mode: NativeUIProjection.CaptureMode,
        delayCover: Boolean = false,
        releaseWhileActive: Boolean = false,
        pressOnConnect: Boolean = false,
        authoritativePlacement: Boolean = false,
    ) {

        val activity = activity()
        lateinit var registration: NativeUIProjection
        lateinit var native: View
        val loaded = CountDownLatch(1)
        val pendingDraws = mutableListOf<() -> Unit>()
        var revealCount = 0
        var pendingPlacement = false
        var pendingNativeY = 0f
        var stopInitialTouch: (() -> Unit)? = null
        fun js(expression: String): String {
            val done = CountDownLatch(1)
            var result = ""
            main {
                activity.web.evaluateJavascript(expression) {
                    result = it
                    done.countDown()
                }
            }
            assertTrue(done.await(3, TimeUnit.SECONDS))
            return result
        }
        fun waitFor(expression: String) {
            val deadline = System.currentTimeMillis() + 10000
            while (System.currentTimeMillis() < deadline) {
                if (js(expression) == "true") return
                Thread.sleep(20)
            }
            fail("Timed out: $expression")
        }
        fun waitNative(visibility: Int) {
            val deadline = System.currentTimeMillis() + 10000
            var matched = false
            while (!matched && System.currentTimeMillis() < deadline) {
                main {
                    // INVISIBLE also occurs during Web fallback; wait for the actual VIEW cover.
                    matched =
                        native.visibility == visibility &&
                            (visibility != View.INVISIBLE || registration.isProjecting)
                }
                Thread.sleep(20)
            }
            assertTrue("Native visibility did not change", matched)
        }
        try {
            main {
                val density = activity.resources.displayMetrics.density
                native = View(activity)
                native.setBackgroundColor(Color.RED)
                activity.root.addView(
                    native,
                    FrameLayout.LayoutParams((100 * density).toInt(), (40 * density).toInt())
                        .apply {
                            leftMargin = (20 * density).toInt()
                            topMargin = (100 * density).toInt()
                        },
                )
                activity.web.webViewClient =
                    object : android.webkit.WebViewClient() {
                        override fun onPageFinished(view: android.webkit.WebView, url: String) {
                            loaded.countDown()
                        }

                        override fun shouldInterceptRequest(
                            view: android.webkit.WebView,
                            request: android.webkit.WebResourceRequest,
                        ): android.webkit.WebResourceResponse? {
                            val path = request.url.path ?: return null
                            if (!path.startsWith("/_capacitor_file_")) return null
                            val file = File(path.removePrefix("/_capacitor_file_"))
                            if (
                                !file.canonicalPath.startsWith(
                                    activity.cacheDir.canonicalPath + "/"
                                )
                            )
                                return null
                            return runCatching {
                                    android.webkit.WebResourceResponse(
                                        "image/png",
                                        null,
                                        file.inputStream(),
                                    )
                                }
                                .getOrNull()
                        }
                    }
                if (pressOnConnect) {
                    val previous = activity.window.callback
                    activity.window.callback =
                        object : android.view.Window.Callback by previous {
                            override fun dispatchTouchEvent(
                                event: android.view.MotionEvent
                            ): Boolean {
                                previous.dispatchTouchEvent(event)
                                return true
                            }
                        }
                    // Install the handled callback beneath the observer, so DOWN stays active
                    // independently of fixture layout or WebView hit testing during startup.
                    var initialTouchActive = false
                    stopInitialTouch =
                        NativeUIWindowInteraction.observe(activity.window) {
                            initialTouchActive = it
                        }
                    val now = android.os.SystemClock.uptimeMillis()
                    val event =
                        android.view.MotionEvent.obtain(
                            now,
                            now,
                            android.view.MotionEvent.ACTION_DOWN,
                            25f * density,
                            105f * density,
                            0,
                        )
                    activity.window.callback.dispatchTouchEvent(event)
                    event.recycle()
                    assertTrue(
                        "Fixture DOWN must remain active before registration",
                        initialTouchActive,
                    )
                }
                registration =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#slot",
                        receiveListeners =
                            NativeUIProjection.ReceiveListeners(
                                update = listOf("updated"),
                                projection =
                                    NativeUIProjection.ReceiveListeners.Projection(
                                        native = listOf("shown"),
                                        web = listOf("moving"),
                                        none = listOf("hidden"),
                                    ),
                            ),
                        failedFallback = NativeUIProjection.FailedFallback.WEB,
                        captureMode = mode,
                        updatePlacement =
                            if (authoritativePlacement)
                                ({ placement ->
                                    assertEquals(View.INVISIBLE, native.visibility)
                                    native.y =
                                        (placement.getDouble("y") * activity.web.width /
                                                placement.getDouble("viewportWidth"))
                                            .toFloat()
                                    pendingPlacement = false
                                    revealCount++
                                })
                            else null,
                        beforeNativeReveal = {
                            assertFalse(registration.isProjecting)
                            if (pendingPlacement) {
                                assertEquals(View.INVISIBLE, native.visibility)
                                pendingPlacement = false
                                native.y = pendingNativeY
                                revealCount++
                            }
                        },
                        readValues = {
                            JSONObject().put("label", native.contentDescription?.toString() ?: "")
                        },
                        view = { native },
                    )
                if (delayCover)
                    registration.awaitWebDraw = { _, current, done ->
                        pendingDraws.add { done(current()) }
                    }
                registration.receive("hidden")
                registration.receive(if (pressOnConnect) "shown" else "moving")

                activity.web.loadDataWithBaseURL(
                    "https://localhost",
                    """
                    <meta name='viewport' content='width=device-width,initial-scale=1'><script>
                    window.testEvents={};window.Capacitor={
                     addListener:(plugin,name,fn)=>{testEvents[name]=fn;return{remove:async()=>{delete testEvents[name]}}},
                     convertFileSrc:url=>'https://localhost/_capacitor_file_'+url.replace('file://','')
                    };</script><body><div id='slot' style='position:absolute;left:20px;top:100px;width:100px;height:40px'>Fallback</div></body>
                    """
                        .trimIndent(),
                    "text/html",
                    "utf-8",
                    null,
                )
            }
            assertTrue("Fixture navigation did not complete", loaded.await(10, TimeUnit.SECONDS))
            waitFor("typeof testEvents?.shown==='function'")
            waitFor("document.querySelector('#slot')!==null")
            main { native.contentDescription = "Current value" }
            js("testEvents.updated({})")
            waitFor("document.querySelector('#slot')?.dataset.nativeUiValueLabel==='Current value'")
            if (pressOnConnect) {
                Thread.sleep(500)
                assertEquals(
                    "false",
                    js("document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')"),
                )
                main {
                    val now = android.os.SystemClock.uptimeMillis()
                    val event =
                        android.view.MotionEvent.obtain(
                            now,
                            now,
                            android.view.MotionEvent.ACTION_CANCEL,
                            0f,
                            0f,
                            0,
                        )
                    activity.window.callback.dispatchTouchEvent(event)
                    event.recycle()
                    stopInitialTouch?.invoke()
                    stopInitialTouch = null
                }
            } else {
                val hiddenDeadline = System.currentTimeMillis() + 3000
                while (System.currentTimeMillis() < hiddenDeadline) {
                    var hidden = false
                    main { hidden = native.visibility == View.INVISIBLE }
                    if (hidden) break
                    Thread.sleep(20)
                }
                main { assertEquals(View.INVISIBLE, native.visibility) }
                js("testEvents.shown({})")
            }
            waitFor(
                "document.querySelector('#slot')?.hasAttribute('data-native-ui-snapshot')===true"
            )
            waitFor("document.querySelector('#slot > img[data-native-ui-projection-image]')!==null")
            if (!delayCover) {
                val before =
                    js("document.querySelector('img[data-native-ui-projection-image]')?.src")
                fun touch(action: Int) {
                    main {
                        native.isClickable = true
                        val location = IntArray(2)
                        native.getLocationInWindow(location)
                        val now = android.os.SystemClock.uptimeMillis()
                        val event =
                            android.view.MotionEvent.obtain(
                                now,
                                now,
                                action,
                                (location[0] + 5).toFloat(),
                                (location[1] + 5).toFloat(),
                                0,
                            )
                        activity.window.callback.dispatchTouchEvent(event)
                        event.recycle()
                    }
                }
                touch(android.view.MotionEvent.ACTION_DOWN)
                main { native.setBackgroundColor(Color.GREEN) }
                js("testEvents.updated({})")
                Thread.sleep(500)
                assertEquals(
                    before,
                    js("document.querySelector('img[data-native-ui-projection-image]')?.src"),
                )
                touch(android.view.MotionEvent.ACTION_CANCEL)
                waitFor(
                    "document.querySelector('img[data-native-ui-projection-image]')?.src!==$before"
                )
            }
            if (delayCover) {
                js("testEvents.moving({})")
                val deadline = System.currentTimeMillis() + 10000
                var waiting = false
                while (!waiting && System.currentTimeMillis() < deadline) {
                    main { waiting = pendingDraws.size >= 2 }
                    Thread.sleep(20)
                }
                assertTrue("Cover did not wait for Web draw", waiting)
                js("testEvents.shown({})")
                waitFor(
                    "document.querySelector('#slot').getAttributeNames().some(n=>n.startsWith('data-native-ui-session-')&&document.querySelector('#slot').getAttribute(n)==='native')"
                )
                main {
                    pendingDraws.toList().forEach { it() }
                    pendingDraws.clear()
                    registration.awaitWebDraw = NativeUIWebReadiness::draw
                }
                Thread.sleep(100)
                main { assertEquals(View.VISIBLE, native.visibility) }
            }

            if (authoritativePlacement)
                js(
                    """
                    // The plugin's latest placement is newer than the image return frame.
                    document.querySelector('#slot')[Symbol.for('webview-native-ui-engine.projection-placement')]={
                      projected:false,invalidate(){},measure(){return {y:parseFloat(document.querySelector('#slot').style.top)+20,viewportWidth:innerWidth}}
                    }
                    """
                        .trimIndent()
                )
            repeat(2) { iteration ->
                waitFor("document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')")
                js("testEvents.moving({})")
                if (mode == NativeUIProjection.CaptureMode.VIEW) waitNative(View.INVISIBLE)
                else
                    waitFor(
                        "document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')"
                    )
                val placementCssWidth = js("innerWidth").toFloat()
                main {
                    assertEquals(View.INVISIBLE, native.visibility)
                    assertEquals(
                        mode == NativeUIProjection.CaptureMode.VIEW,
                        registration.isProjecting,
                    )
                    pendingPlacement = mode == NativeUIProjection.CaptureMode.VIEW
                    pendingNativeY = (120 + iteration * 20) * activity.web.width / placementCssWidth
                }
                js("document.querySelector('#slot').style.top='${120+iteration*20}px'")
                if (releaseWhileActive) {
                    js("window.dispatchEvent(new Event('resize'))")
                    val deadline = System.currentTimeMillis() + 5000
                    var flushed = false
                    while (!flushed && System.currentTimeMillis() < deadline) {
                        main { flushed = revealCount == iteration + 1 }
                        Thread.sleep(20)
                    }
                    assertTrue("Active image release must apply pending placement", flushed)
                    main { assertFalse(registration.isProjecting) }
                }
                js("testEvents.shown({})")
                if (mode == NativeUIProjection.CaptureMode.VIEW) waitNative(View.VISIBLE)
                else
                    waitFor(
                        "!document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')"
                    )
                val cssWidth = js("innerWidth").toFloat()
                main {
                    assertEquals(View.VISIBLE, native.visibility)
                    if (mode == NativeUIProjection.CaptureMode.COMPOSITED)
                        assertEquals(
                            (20 + iteration * 20) * activity.web.width / cssWidth,
                            native.translationY,
                            0.05f,
                        ) // CSS layout quantization stays below 0.05 physical px.
                    else {
                        val location = IntArray(2)
                        val origin = IntArray(2)
                        native.getLocationInWindow(location)
                        activity.web.getLocationInWindow(origin)
                        assertEquals(
                            (120 + iteration * 20 + (if (authoritativePlacement) 20 else 0)) *
                                activity.web.width / cssWidth,
                            (location[1] - origin[1]).toFloat(),
                            1f,
                        )
                    }
                }
            }
            waitFor("document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')")
            js("testEvents.moving({})")
            if (mode == NativeUIProjection.CaptureMode.VIEW) waitNative(View.INVISIBLE)
            else
                waitFor(
                    "document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')"
                )
            main { assertEquals(View.INVISIBLE, native.visibility) }
            val hidden = CountDownLatch(1)
            var hiddenResult = false
            main {
                registration.hide {
                    hiddenResult = it
                    hidden.countDown()
                }
            }
            assertTrue(hidden.await(6, TimeUnit.SECONDS))
            assertTrue(hiddenResult)
            waitFor(
                "document.querySelector('#slot').getAttributeNames().some(n=>n.startsWith('data-native-ui-session-')&&document.querySelector('#slot').getAttribute(n)==='none')"
            )
            main {
                assertEquals(View.INVISIBLE, native.visibility)
                assertFalse(registration.isProjecting)
                assertEquals(if (mode == NativeUIProjection.CaptureMode.VIEW) 2 else 0, revealCount)
                registration.close()
            }
            waitFor("Object.keys(testEvents).length===0")
        } finally {
            main { activity.finish() }
        }
    }

    @Test
    fun sharedChannelSupportsLateOwnersAndIndependentTeardown() {
        val activity = activity()
        lateinit var first: NativeUIProjection
        lateinit var second: NativeUIProjection
        lateinit var native: View
        fun js(expression: String): String {
            val done = CountDownLatch(1)
            var result = ""
            main {
                activity.web.evaluateJavascript(expression) {
                    result = it
                    done.countDown()
                }
            }
            assertTrue(done.await(3, TimeUnit.SECONDS))
            return result
        }
        fun waitCount(count: Int) {
            val expression =
                "Array.from(document.querySelectorAll('style')).filter(s=>s.textContent.includes('data-native-ui-session-')).length"
            val deadline = System.currentTimeMillis() + 10000
            while (System.currentTimeMillis() < deadline) {
                if (js(expression) == count.toString()) return
                Thread.sleep(20)
            }
            fail("Expected $count live owners")
        }
        try {
            js(
                "window.testEvents={};window.Capacitor={addListener:(plugin,name,fn)=>{testEvents[name]=fn;return{remove:async()=>{delete testEvents[name]}}}};document.body.insertAdjacentHTML('beforeend','<div id=second style=width:100px;height:40px>Fallback</div>')"
            )
            main {
                NativeUIProjection.install(activity.web)
                try {
                    NativeUIProjection.install(activity.web, setOf("https://unrelated.example"))
                    fail("Changed origins accepted")
                } catch (_: IllegalArgumentException) {}
                first =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#first",
                        view = { null },
                    )
                native = View(activity)
                activity.root.addView(native, FrameLayout.LayoutParams(100, 40))
                second =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#second",
                        receiveListeners =
                            NativeUIProjection.ReceiveListeners(
                                projection =
                                    NativeUIProjection.ReceiveListeners.Projection(
                                        none = listOf("hidden")
                                    )
                            ),
                        failedFallback = NativeUIProjection.FailedFallback.NATIVE,
                        canCapture = { false },
                        view = { native },
                    )
                second.receive("hidden")
                second.hide()
                second.show()
            }
            waitCount(2)
            val visibleDeadline = System.currentTimeMillis() + 10000
            var visible = false
            while (!visible && System.currentTimeMillis() < visibleDeadline) {
                main { visible = native.visibility == View.VISIBLE }
                Thread.sleep(20)
            }
            assertTrue("Early hide/show must preserve native presentation intent", visible)
            main { first.close() }
            waitCount(1)
            val deadline = System.currentTimeMillis() + 10000
            while (
                js("typeof testEvents.hidden") != "\"function\"" &&
                    System.currentTimeMillis() < deadline
            ) Thread.sleep(20)
            js("testEvents.hidden({})")
            var hidden = false
            while (!hidden && System.currentTimeMillis() < deadline) {
                main { hidden = native.visibility == View.INVISIBLE }
                Thread.sleep(20)
            }
            assertTrue("Remaining owner must still receive native channel commands", hidden)
            main { second.close() }
            waitCount(0)
            main {
                first =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "Fixture",
                        "#third",
                        view = { null },
                    )
            }
            waitCount(1)
            main { first.close() }
            waitCount(0)
        } finally {
            main { activity.finish() }
        }
    }
}
