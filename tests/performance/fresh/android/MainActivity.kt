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
object NativeEncoder {
 var mode="Android";var encodeMS=0.0;var convertMS=0.0;var validate=false
 fun write(bitmap:Bitmap,out:OutputStream):Boolean {
  val start=now()
  try {
   return if(mode=="Production") NativeUIPng.write(bitmap,out)
   else bitmap.compress(Bitmap.CompressFormat.PNG,100,out)
  }finally {encodeMS+=now()-start}
 }
 fun now()=SystemClock.elapsedRealtimeNanos()/1e6
}
class MainActivity:Activity() {
 lateinit var web:WebView;lateinit var root:FrameLayout;lateinit var snapshots:NativeUISnapshots
 val controls=mutableListOf<View>();val rows=JSONArray();val handler=Handler(Looper.getMainLooper());var step=0;var trial=0;var mode="";var started=0.0;var prepared=0.0;var token="";var bytes=0L
 override fun onCreate(state:Bundle?) {
  super.onCreate(state);window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  root=FrameLayout(this);setContentView(root);web=WebView(this);web.settings.javaScriptEnabled=true;root.addView(web,FrameLayout.LayoutParams(-1,-1))
  snapshots=NativeUISnapshots(File(cacheDir,"captures"));web.addJavascriptInterface(Bridge(),"Bench")
  web.webViewClient=object:WebViewClient() {
   override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse? {
    if(request.url.host!="snapshot.invalid")return null
    return try {WebResourceResponse("image/png",null,File(request.url.path!!).inputStream())}catch(e:Exception){WebResourceResponse("image/png",null,ByteArrayInputStream(ByteArray(0)))}
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
  NativeEncoder.encodeMS=0.0;NativeEncoder.convertMS=0.0;started=NativeEncoder.now()
  web.evaluateJavascript("window.innerWidth") {width->
   snapshots.prepare(window,web,width.toDouble(),frames={
    val ref=IntArray(2);web.getLocationInWindow(ref)
    controls.mapIndexed{i,v->val p=IntArray(2);v.getLocationInWindow(p);i.toString() to RectF((p[0]-ref[0]).toFloat(),(p[1]-ref[1]).toFloat(),(p[0]-ref[0]+v.width).toFloat(),(p[1]-ref[1]+v.height).toFloat())}.toMap()
   }) {value->
    prepared=NativeEncoder.now();val parts=value.optJSONArray("parts")
    if(parts==null || parts.length()!=12){fail("capture empty: $value");return@prepare}
    token=value.getString("token");bytes=0L
    for(i in 0 until parts.length()){val p=parts.getJSONObject(i);val path=android.net.Uri.parse(p.getString("url")).path!!;bytes+=File(path).length();p.put("url","https://snapshot.invalid$path")}
    controls.forEach{it.visibility=View.INVISIBLE}
    val script="""(async()=>{try {const parts=$parts;const box=document.getElementById('copies');await Promise.all(parts.map(async p=>{const img=new Image();img.src=p.url;await img.decode();img.style.cssText=`position:fixed;left:${'$'}{p.x}px;top:${'$'}{p.y}px;width:${'$'}{p.width}px;height:${'$'}{p.height}px`;box.append(img)}));requestAnimationFrame(()=>requestAnimationFrame(()=>Bench.done(true,'')));}catch(e){Bench.done(false,String(e))}})();true"""
    web.evaluateJavascript(script,null)
   }
  }
 }
 inner class Bridge {
  @JavascriptInterface fun done(ok:Boolean,error:String){runOnUiThread {
   if(!ok){fail(error);return@runOnUiThread}
   NativeUIWebReadiness.draw(web,{true}) {ready->
    if(!ready){fail("draw timeout");return@draw}
    val end=NativeEncoder.now();rows.put(JSONObject().put("mode",mode).put("trial",trial).put("total_ms",end-started).put("prepare_ms",prepared-started).put("encode_write_ms",NativeEncoder.encodeMS).put("rgba_ms",NativeEncoder.convertMS).put("web_ms",end-prepared).put("bytes",bytes))
    snapshots.release(token);next()
   }
  }}
 }
 fun fail(message:String){File(filesDir,"error.txt").writeText(message);android.util.Log.e("SnapshotBench",message)}
}
