package io.github.webview_native_ui.engine
import android.app.Activity
import android.os.*
import android.graphics.*
import android.view.*
import android.widget.*
import android.webkit.*
import org.json.*
import java.io.*
import java.nio.ByteBuffer
internal fun RectF.valid()=listOf(left,top,right,bottom).all{it.isFinite() && it in -1_000_000f..1_000_000f} && width()>0 && height()>0
object WebStages {
 var visualReady=0.0;var drawObserved=0.0
 var opened=0;var readBytes=0L;var readMS=0.0;var openMS=0.0
 @Synchronized fun reset(){visualReady=0.0;drawObserved=0.0;opened=0;readBytes=0;readMS=0.0;openMS=0.0}
 @Synchronized fun opened(ms:Double){opened++;openMS+=ms}
 @Synchronized fun read(n:Int,ms:Double){if(n>0)readBytes+=n;readMS+=ms}
 @Synchronized fun json()=JSONObject().put("file_requests",opened).put("file_read_bytes",readBytes).put("file_read_sum_ms",readMS).put("file_open_sum_ms",openMS)
}
object NativeEncoder {
 val workers get()=if(mode=="Serial" || mode=="Android") 1 else 2
 var mode="Android";var encodeMS=0.0;var convertMS=0.0;var validate=false;var active=0;var peakActive=0;var heapPeak=0L;var heapBase=0L;var firstEncode=Double.POSITIVE_INFINITY;var lastEncode=0.0
 fun write(bitmap:Bitmap,out:OutputStream):Boolean {
  val start=now()
  synchronized(this){firstEncode=minOf(firstEncode,start);active++;peakActive=maxOf(peakActive,active);heapPeak=maxOf(heapPeak,Debug.getNativeHeapAllocatedSize())}
  try {
   return if(mode!="Android") NativeUIPng.write(bitmap,out)
   else bitmap.compress(Bitmap.CompressFormat.PNG,100,out)
  }finally {val end=now();synchronized(this){lastEncode=maxOf(lastEncode,end);encodeMS+=end-start;heapPeak=maxOf(heapPeak,Debug.getNativeHeapAllocatedSize());active--}}
 }
 fun now()=SystemClock.elapsedRealtimeNanos()/1e6
}
class MainActivity:Activity() {
 lateinit var web:WebView;lateinit var root:FrameLayout;lateinit var snapshots:NativeUISnapshots
 val controls=mutableListOf<View>();val rows=JSONArray();val handler=Handler(Looper.getMainLooper());var step=0;var trial=0;var mode="";var started=0.0;var prepared=0.0;var token="";var bytes=0L;var hashes=JSONArray()
 override fun onCreate(state:Bundle?) {
  super.onCreate(state);window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  root=FrameLayout(this);setContentView(root);web=WebView(this);web.settings.javaScriptEnabled=true;root.addView(web,FrameLayout.LayoutParams(-1,-1))
  snapshots=NativeUISnapshots(File(cacheDir,"captures"));web.addJavascriptInterface(Bridge(),"Bench")
  web.webViewClient=object:WebViewClient() {
   override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse? {
    if(request.url.host!="snapshot.invalid")return null
    return try {
     val start=NativeEncoder.now();val stream=File(request.url.path!!).inputStream();WebStages.opened(NativeEncoder.now()-start)
     val counted=object:FilterInputStream(stream){
      override fun read():Int {val t=NativeEncoder.now();val n=stream.read();WebStages.read(if(n<0)0 else 1,NativeEncoder.now()-t);return n}
      override fun read(b:ByteArray,off:Int,len:Int):Int {val t=NativeEncoder.now();val n=stream.read(b,off,len);WebStages.read(n,NativeEncoder.now()-t);return n}
     }
     WebResourceResponse("image/png",null,counted)
    }catch(e:Exception){WebResourceResponse("image/png",null,ByteArrayInputStream(ByteArray(0)))}
   }
   override fun onPageFinished(view:WebView,url:String){android.util.Log.i("SnapshotBench","page finished");handler.postDelayed({next()},1000)}
  }
  web.loadDataWithBaseURL("https://screen.invalid","<meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:linear-gradient(130deg,#bcdbff,#fff1c8);height:100vh;font:16px sans-serif'><h2 style='padding:15px'>Android snapshot</h2><p>PixelCopy → PNG → WebView</p><div id='copies'></div></body>","text/html","UTF-8",null)
  root.viewTreeObserver.addOnGlobalLayoutListener(object:android.view.ViewTreeObserver.OnGlobalLayoutListener {
   override fun onGlobalLayout() {
   if(root.width==0 || root.height==0)return
   root.viewTreeObserver.removeOnGlobalLayoutListener(this)
   for(i in 0..11) {
    val b=Button(this@MainActivity);b.text=listOf("Home","Search","Favorites","Library")[i%4];b.textSize=12f;b.setTextColor(Color.WHITE);b.backgroundTintList=android.content.res.ColorStateList.valueOf(listOf(0xff3569a8.toInt(),0xff7351b5.toInt(),0xff147e88.toInt())[i%3])
    val lp=FrameLayout.LayoutParams(root.width/2-12,(root.height-170)/6-6);lp.leftMargin=6+(i%2)*root.width/2;lp.topMargin=150+(i/2)*(root.height-170)/6
    root.addView(b,lp);controls.add(b)
   }
   }
  })
 }
 fun next() {
  android.util.Log.i("SnapshotBench","next step=$step controls=${controls.size} root=${root.width}x${root.height}")
  val options=intent.getStringExtra("modes")?.split(",") ?: listOf("Android","Production")
  if(step>=33*options.size){File(filesDir,"screen-results.json").writeText(rows.toString(2));return}
  trial=step/options.size;mode=options[(step%options.size+trial)%options.size];step++;NativeEncoder.mode=mode;NativeEncoder.validate=trial<3
  web.evaluateJavascript("document.getElementById('copies').replaceChildren();true") {
   controls.forEach{it.visibility=View.VISIBLE};handler.postDelayed({capture()},100)
  }
 }
 fun capture() {
  NativeEncoder.encodeMS=0.0;NativeEncoder.convertMS=0.0;NativeEncoder.peakActive=0;NativeEncoder.firstEncode=Double.POSITIVE_INFINITY;NativeEncoder.lastEncode=0.0;NativeEncoder.heapBase=Debug.getNativeHeapAllocatedSize();NativeEncoder.heapPeak=NativeEncoder.heapBase;hashes=JSONArray();started=NativeEncoder.now()
  web.evaluateJavascript("window.innerWidth") {width->
   snapshots.prepare(window,web,width.toDouble(),frames={
    val ref=IntArray(2);web.getLocationInWindow(ref)
    controls.mapIndexed{i,v->val p=IntArray(2);v.getLocationInWindow(p);i.toString() to RectF((p[0]-ref[0]).toFloat(),(p[1]-ref[1]).toFloat(),(p[0]-ref[0]+v.width).toFloat(),(p[1]-ref[1]+v.height).toFloat())}.toMap()
   }) {value->
    prepared=NativeEncoder.now();WebStages.reset();val parts=value.optJSONArray("parts")
    if(parts==null || parts.length()!=12){fail("capture empty: $value");return@prepare}
    token=value.getString("token");bytes=0L
    for(i in 0 until parts.length()){val p=parts.getJSONObject(i);val path=android.net.Uri.parse(p.getString("url")).path!!;bytes+=File(path).length();if(trial<3){hashes.put(java.security.MessageDigest.getInstance("SHA-256").digest(File(path).readBytes()).joinToString(""){"%02x".format(it)})};p.put("url","https://snapshot.invalid$path")}
    controls.forEach{it.visibility=View.INVISIBLE}
    val script="""(async()=>{const start=performance.now();let lastLoad=0;try {const parts=$parts;const box=document.getElementById('copies');await Promise.all(parts.map(async p=>{const img=new Image();img.onload=()=>{lastLoad=Math.max(lastLoad,performance.now()-start)};img.src=p.url;await img.decode();img.style.cssText=`position:fixed;left:${'$'}{p.x}px;top:${'$'}{p.y}px;width:${'$'}{p.width}px;height:${'$'}{p.height}px`;box.append(img)}));const images=performance.now()-start;requestAnimationFrame(()=>requestAnimationFrame(()=>Bench.done(true,'',JSON.stringify({js_images_ms:images,js_last_load_ms:lastLoad,js_decode_tail_ms:Math.max(0,images-lastLoad),js_raf_ms:performance.now()-start-images,js_total_ms:performance.now()-start}))));}catch(e){Bench.done(false,String(e),'{}')}})();true"""
    web.evaluateJavascript(script,null)
   }
  }
 }
 inner class Bridge {
  @JavascriptInterface fun done(ok:Boolean,error:String,details:String){
   val received=NativeEncoder.now()
   runOnUiThread {
    val ui=NativeEncoder.now()
    if(!ok){fail(error);return@runOnUiThread}
    NativeUIWebReadiness.draw(web,{true}) {ready->
     if(!ready){fail("draw timeout");return@draw}
     val end=NativeEncoder.now()
     val row=JSONObject(details).put("mode",mode).put("trial",trial).put("total_ms",end-started).put("prepare_ms",prepared-started).put("encode_write_sum_ms",NativeEncoder.encodeMS).put("encode_write_span_ms",NativeEncoder.lastEncode-NativeEncoder.firstEncode).put("web_ms",end-prepared).put("bytes",bytes)
     row.put("warmup_png_sha256",hashes).put("peak_workers",NativeEncoder.peakActive).put("sampled_native_heap_delta_bytes",maxOf(0L,NativeEncoder.heapPeak-NativeEncoder.heapBase))
     row.put("dispatch_ack_ms",received-prepared).put("bridge_ui_queue_ms",ui-received)
     row.put("native_visual_ms",WebStages.visualReady-ui).put("native_draw_ms",end-WebStages.visualReady).put("native_draw_post_ms",end-WebStages.drawObserved)
     row.put("dispatch_residual_ms",received-prepared-row.getDouble("js_total_ms"))
     val file=WebStages.json();file.keys().forEach{key->row.put(key,file.get(key))}
     rows.put(row);snapshots.release(token);next()
    }
   }
  }
 }
 fun fail(message:String){File(filesDir,"error.txt").writeText(message);android.util.Log.e("SnapshotBench",message)}
}
