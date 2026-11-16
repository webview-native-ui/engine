package io.github.webview_native_ui.engine

import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

/** Exercise the public SDK registration, including its own transport and original native input. */
class NativeUIProjectionContactTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)

    @Test
    fun compositedSDKContactCapturesDuringVirtualChanges() =
        verify(NativeUIProjection.CaptureMode.COMPOSITED)

    @Test
    fun viewSDKContactCapturesDuringVirtualChanges() = verify(NativeUIProjection.CaptureMode.VIEW)

    @Test
    fun hostedSDKStopsWebMotionBeforeAcquisitionAndOriginalInput() =
        verify(NativeUIProjection.CaptureMode.VIEW, hosted = true)

    private fun verify(mode: NativeUIProjection.CaptureMode, hosted: Boolean = false) {
        val activity =
            instrumentation.startActivitySync(
                Intent(instrumentation.targetContext, EngineTestActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ) as EngineTestActivity
        lateinit var registration: NativeUIProjection
        lateinit var button: Button
        val loaded = CountDownLatch(1)
        val clicked = CountDownLatch(1)
        var clickCount = 0
        var trackingContact = false
        var webDowns = 0
        var stopsAtAcquisition: Int? = null
        fun js(expression: String): String {
            val done = CountDownLatch(1)
            var result = ""
            main {
                activity.web.evaluateJavascript(expression) {
                    result = it
                    done.countDown()
                }
            }
            assertTrue("Web evaluation did not finish", done.await(3, TimeUnit.SECONDS))
            return result
        }
        fun diagnostics(): String =
            js(
                """
                JSON.stringify({events:nativeEvents.filter(e=>!e.capturePolicy).slice(-25),
                  virtualChanges,attributes:[...document.querySelector('#slot').attributes].map(a=>[a.name,a.value]),
                  images:[...document.querySelectorAll('#slot img')].map(i=>({src:i.src,complete:i.complete,width:i.naturalWidth,opacity:getComputedStyle(i).opacity,display:getComputedStyle(i).display}))})
                """
                    .trimIndent()
            )
        fun waitFor(expression: String) {
            val deadline = SystemClock.uptimeMillis() + 10000
            while (SystemClock.uptimeMillis() < deadline) {
                if (js(expression) == "true") return
                Thread.sleep(20)
            }
            fail("Timed out: $expression; state=" + diagnostics())
        }
        fun waitNative(visibility: Int) {
            val deadline = SystemClock.uptimeMillis() + 5000
            while (SystemClock.uptimeMillis() < deadline) {
                var actual = -1
                main { actual = button.visibility }
                if (actual == visibility) return
                Thread.sleep(20)
            }
            fail("Native visibility did not reach $visibility; state=" + diagnostics())
        }
        try {
            main {
                val density = activity.resources.displayMetrics.density
                if (hosted) {
                    val previous = activity.web
                    activity.root.removeView(previous)
                    previous.destroy()
                    activity.web =
                        object : WebView(activity) {
                                override fun onTouchEvent(event: MotionEvent): Boolean {
                                    if (
                                        trackingContact &&
                                            event.actionMasked == MotionEvent.ACTION_DOWN
                                    )
                                        webDowns++
                                    return super.onTouchEvent(event)
                                }
                            }
                            .apply { settings.javaScriptEnabled = true }
                    activity.root.addView(activity.web, 0, FrameLayout.LayoutParams(-1, -1))
                }
                button =
                    object : Button(activity) {
                            override fun draw(canvas: Canvas) {
                                if (
                                    trackingContact &&
                                        !canvas.isHardwareAccelerated &&
                                        stopsAtAcquisition == null
                                )
                                    stopsAtAcquisition = webDowns
                                super.draw(canvas)
                            }
                        }
                        .apply {
                            text = "SDK"
                            setBackgroundColor(Color.RED)
                            setOnClickListener {
                                clickCount++
                                trackingContact = false
                                // SDK input changes the live pixels; capture must precede it.
                                setBackgroundColor(Color.GREEN)
                                registration.receive("moving")
                                // Capacitor forwards the same SDK event to its Web proxy.
                                activity.web.evaluateJavascript("testEvents.moving({})", null)
                                clicked.countDown()
                            }
                        }
                activity.root.addView(
                    if (hosted) NativeUIScrollHosting(activity.web, button) else button,
                    FrameLayout.LayoutParams((100 * density).toInt(), (50 * density).toInt())
                        .apply {
                            leftMargin = (20 * density).toInt()
                            topMargin = (100 * density).toInt()
                        },
                )
                activity.web.webViewClient =
                    object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String) {
                            loaded.countDown()
                        }

                        override fun shouldInterceptRequest(
                            view: WebView,
                            request: WebResourceRequest,
                        ): WebResourceResponse? {
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
                                    WebResourceResponse("image/png", null, file.inputStream())
                                }
                                .getOrNull()
                        }
                    }
                registration =
                    NativeUIProjection(
                        activity.window,
                        activity.web,
                        "SDK",
                        "#slot",
                        receiveListeners =
                            NativeUIProjection.ReceiveListeners(
                                projection =
                                    NativeUIProjection.ReceiveListeners.Projection(
                                        native = listOf("shown"),
                                        web = listOf("moving"),
                                    )
                            ),
                        failedFallback = NativeUIProjection.FailedFallback.WEB,
                        captureMode = mode,
                        captureDelayMs = 1000,
                        view = { button },
                    )
                activity.web.loadDataWithBaseURL(
                    "https://localhost",
                    """
                    <meta name="viewport" content="width=device-width,initial-scale=1">
                    <script>
                    window.testEvents={};window.nativeEvents=[];window.virtualChanges=0;
                    const runtime=globalThis.WebViewNativeUIEngineRuntime;
                    const receive=runtime.receive;
                    globalThis.WebViewNativeUIEngineRuntime={...runtime,receive:(id,key,value,error)=>{
                      if(key===null) nativeEvents.push(value);
                      return receive(id,key,value,error);
                    }};
                    window.Capacitor={
                      addListener:(plugin,name,fn)=>{testEvents[name]=fn;return{remove:async()=>delete testEvents[name]}},
                      convertFileSrc:url=>'https://localhost/_capacitor_file_'+url.replace('file://','')
                    };
                    </script>
                    <body style="margin:0">
                    <div id="slot" style="position:absolute;left:20px;top:100px;width:100px;height:50px">Web fallback</div>
                    <div id="rows" style="position:absolute;top:220px;width:100%;height:900px;background:#acf">Recycled rows</div>
                    </body>
                    """
                        .trimIndent(),
                    "text/html",
                    "utf-8",
                    null,
                )
            }
            assertTrue("Fixture navigation did not finish", loaded.await(10, TimeUnit.SECONDS))
            waitFor("typeof testEvents.shown==='function'")
            js("testEvents.shown({})")
            waitFor("document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')")
            waitFor(
                "nativeEvents.some(event=>event.capturePolicy==='preinteraction'&&event.prepareDuringInteraction===true)"
            )
            // Retire the settled image, then keep changing virtual rows. Native acquisition is
            // delayed by 1s, so a fresh immutable image is available only through contact.
            js(
                """
                window.policiesBefore=nativeEvents.filter(e=>e.capturePolicy).length;
                window.virtualChanges=0;window.keepChanging=true;
                function recycle(){
                  if(!keepChanging)return;
                  const rows=document.querySelector('#rows');
                  rows.textContent='Recycled '+(++virtualChanges);
                  rows.style.transform='translateY('+(virtualChanges%7)+'px)';
                  requestAnimationFrame(recycle);
                }
                recycle();dispatchEvent(new Event('resize'));
                """
                    .trimIndent()
            )
            waitFor(
                "nativeEvents.filter(e=>e.capturePolicy).length>policiesBefore&&virtualChanges>=3"
            )
            assertEquals(
                "Contact must not use a previously settled image",
                "false",
                js("document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')"),
            )
            main {
                assertEquals(View.VISIBLE, button.visibility)
                // Require fresh VIEW pixels, rather than reusing the initial settled raster.
                if (hosted) button.alpha = 0.99f
                trackingContact = hosted
                val location = IntArray(2)
                val origin = IntArray(2)
                button.getLocationOnScreen(location)
                activity.window.decorView.getLocationOnScreen(origin)
                val now = SystemClock.uptimeMillis()
                for ((action, time) in
                    listOf(MotionEvent.ACTION_DOWN to now, MotionEvent.ACTION_UP to now + 40)) {
                    val event =
                        MotionEvent.obtain(
                            now,
                            time,
                            action,
                            location[0] - origin[0] + button.width / 2f,
                            location[1] - origin[1] + button.height / 2f,
                            0,
                        )
                    activity.window.callback.dispatchTouchEvent(event)
                    event.recycle()
                }
            }
            assertTrue("Original SDK tap was lost", clicked.await(4, TimeUnit.SECONDS))
            assertEquals(1, clickCount)
            if (hosted) {
                assertEquals(
                    "Web motion was not stopped before acquiring VIEW pixels",
                    1,
                    stopsAtAcquisition ?: -1,
                )
            }
            waitFor(
                "document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')"
            )
            waitFor(
                "[...document.querySelectorAll('#slot img[data-native-ui-projection-image]')].some(image=>image.complete&&image.naturalWidth>0&&getComputedStyle(image).opacity==='1')"
            )
            waitFor(
                "nativeEvents.some(event=>event.captureID&&event.captureOwner&&event.captureState==='processing')"
            )
            // The SDK paints green as soon as its original click is dispatched. Red pixels prove
            // this is the pre-contact image rather than a late screenshot of the SDK action.
            assertEquals(
                "SDK action was captured instead of pre-contact pixels",
                "true",
                js(
                    """
                    (()=>{
                      const image=document.querySelector('#slot img[data-native-ui-projection-image]');
                      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
                      const context=canvas.getContext('2d');context.drawImage(image,0,0);
                      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
                      let red=0,green=0;
                      for(let i=0;i<pixels.length;i+=4){
                        if(pixels[i]>200&&pixels[i+1]<80&&pixels[i+2]<80)red++;
                        if(pixels[i]<80&&pixels[i+1]>200&&pixels[i+2]<80)green++;
                      }
                      return red>canvas.width*canvas.height/4&&green===0;
                    })()
                    """
                        .trimIndent()
                ),
            )
            waitNative(View.INVISIBLE)
            main { registration.receive("shown") }
            js("keepChanging=false;testEvents.shown({})")
            waitFor("document.querySelector('#slot').dataset.nativeUiDestination==='native'")
            waitNative(View.VISIBLE)
        } catch (error: Throwable) {
            throw AssertionError(
                "SDK contact fixture failed ($mode, hosted=$hosted); state=" +
                    runCatching { diagnostics() }
                        .getOrElse { "diagnostics unavailable: ${it.message}" },
                error,
            )
        } finally {
            main {
                registration.close()
                activity.finish()
            }
        }
    }
}
