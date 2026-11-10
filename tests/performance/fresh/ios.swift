import UIKit
import WebKit
import Foundation
import CoreImage
import CryptoKit
var backend="UIKit"
let timingLock=NSLock()
var encodeMS=0.0
var benchmarkWorkers:Int { backend == "Serial" || backend == "UIKit" ? 1 : 2 }
var convertMS=0.0
var validatePixels=false
var activeEncodes=0
var peakEncodes=0
var firstEncode=Double.infinity
var lastEncode=0.0
var sampledResident:UInt64=0
var residentBase:UInt64=0
func residentBytes()->UInt64 {
 var info=mach_task_basic_info();var count=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<integer_t>.size)
 let result=withUnsafeMutablePointer(to:&info){pointer in pointer.withMemoryRebound(to:integer_t.self,capacity:Int(count)){task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&count)}}
 return result == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}
func clockMS()->Double { ProcessInfo.processInfo.systemUptime*1000 }
func benchmarkPNG(_ image:CIImage, colorSpace:CGColorSpace, platform:CIContext, rust:NativeUIPngEncoder)->Data? {
 let t=clockMS();timingLock.lock();firstEncode=min(firstEncode,t);activeEncodes+=1;peakEncodes=max(peakEncodes,activeEncodes);sampledResident=max(sampledResident,residentBytes());timingLock.unlock()
 defer{let end=clockMS();timingLock.lock();lastEncode=max(lastEncode,end);encodeMS += end-t;sampledResident=max(sampledResident,residentBytes());activeEncodes-=1;timingLock.unlock()}
 if backend == "UIKit" { return platform.pngRepresentation(of:image,format:.RGBA16,colorSpace:colorSpace,options:[:]) }
 return rust.encode(image,colorSpace:colorSpace)
}
@main class App:UIResponder,UIApplicationDelegate {
 func application(_ app:UIApplication,didFinishLaunchingWithOptions opts:[UIApplication.LaunchOptionsKey:Any]?=nil)->Bool {true}
}
class Scene:UIResponder,UIWindowSceneDelegate {
 var window:UIWindow?
 func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions) {
  let w=UIWindow(windowScene:scene as! UIWindowScene);w.rootViewController=Screen();w.makeKeyAndVisible();window=w
 }
}
class Files:NSObject,WKURLSchemeHandler {
 func webView(_ webView:WKWebView,start task:WKURLSchemeTask) {
  do {let url=URL(fileURLWithPath:task.request.url!.path);let data=try Data(contentsOf:url);task.didReceive(URLResponse(url:task.request.url!,mimeType:"image/png",expectedContentLength:data.count,textEncodingName:nil));task.didReceive(data);task.didFinish()}
  catch {task.didFailWithError(error)}
 }
 func webView(_ webView:WKWebView,stop task:WKURLSchemeTask) {}
}
class Screen:UIViewController,WKScriptMessageHandler,WKNavigationDelegate {
 var web:WKWebView!;var controls=[UIView]();let snapshots=NativeUICoveredSnapshots()
 var rows=[[String:Any]]();var step=0;var started=0.0;var prepared=0.0;var lastToken="";var lastBytes=0;var runMode="";var trial=0;var hashes=[String]()
 let modes:[String] = {
  let args=CommandLine.arguments
  if let i=args.firstIndex(of:"--modes"),i+1<args.count {return args[i+1].components(separatedBy:",")}
  return ["UIKit","Rust"]
 }()
 let out=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0]
 override func viewDidLoad() {
  super.viewDidLoad();view.backgroundColor = .systemBackground
  let config=WKWebViewConfiguration();config.setURLSchemeHandler(Files(),forURLScheme:"snapshot");config.userContentController.add(self,name:"done")
  web=WKWebView(frame:.zero,configuration:config);web.navigationDelegate=self;web.scrollView.contentInsetAdjustmentBehavior = .never;view.addSubview(web)
  web.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:linear-gradient(135deg,#bcdbff,#fff1c8);font:18px -apple-system'><div style='padding:110px 24px'><h1>Native UI snapshot</h1><p>Real UIKit controls → compositor capture → PNG → WebKit decode → two animation frames</p><p>Performance verification</p></div><div id='copies'></div></body>",baseURL:URL(string:"https://benchmark.invalid"))
  for i in 0..<12 {
   var cfg=UIButton.Configuration.glass();cfg.title=["Home","Search","Favorites","Library"][i%4];cfg.image=UIImage(systemName:["house.fill","magnifyingglass","star.fill","books.vertical.fill"][i%4]);cfg.imagePadding=8
   let b=UIButton(configuration:cfg);b.tintColor=[UIColor.systemBlue,.systemPurple,.systemTeal][i%3];view.addSubview(b);controls.append(b)
  }
 }
 override func viewDidLayoutSubviews() {
  super.viewDidLayoutSubviews();web.frame=view.bounds
  for (i,v) in controls.enumerated() {v.frame=CGRect(x:20+CGFloat(i%2)*(view.bounds.width/2),y:370+CGFloat(i/2)*62,width:view.bounds.width/2-30,height:48)}
 }
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
  DispatchQueue.main.asyncAfter(deadline:.now()+1) {self.next()}
 }
 func next() {
  if step>=33*modes.count {finish();return}
  // Interleave encoders per round; rotate order each round to reduce drift.
  trial=step/modes.count;validatePixels=trial<3;let index=(step%modes.count+trial)%modes.count;runMode=modes[index];backend=runMode;step+=1
  web.evaluateJavaScript("document.getElementById('copies').replaceChildren();true") {_,error in
   if error != nil {self.fail("clear");return}
   self.controls.forEach{$0.isHidden=false}
   DispatchQueue.main.asyncAfter(deadline:.now()+0.1) {self.capture()}
  }
 }
 func capture() {
  encodeMS=0;convertMS=0;peakEncodes=0;firstEncode=Double.infinity;lastEncode=0;residentBase=residentBytes();sampledResident=residentBase;hashes=[];started=clockMS()
  snapshots.prepare(frames:{Dictionary(uniqueKeysWithValues:self.controls.enumerated().map{(String($0.offset),self.web.convert($0.element.bounds,from:$0.element))})},in:web,viewportWidth:web.bounds.width) {value in
   self.prepared=clockMS()
   guard let token=value["token"] as? String,let parts=value["parts"] as? [[String:Any]],parts.count==12 else {self.fail("capture");return}
   self.lastToken=token
   do {
    if self.trial<3 {self.hashes=try parts.map {p in SHA256.hash(data:try Data(contentsOf:URL(string:p["url"] as! String)!)).map{String(format:"%02x",$0)}.joined()}}
    self.lastBytes=try parts.reduce(0) {sum,p in sum + (try Data(contentsOf:URL(string:p["url"] as! String)!)).count}
    var display=parts
    for i in display.indices {display[i]["url"]=(display[i]["url"] as! String).replacingOccurrences(of:"file://",with:"snapshot://local")}
    let json=String(data:try JSONSerialization.data(withJSONObject:display),encoding:.utf8)!
    let script="""
    (async()=>{try{const parts=\(json);const box=document.getElementById('copies');await Promise.all(parts.map(async p=>{const img=new Image();img.src=p.url;await img.decode();img.style.cssText=`position:fixed;left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px`;box.append(img)}));requestAnimationFrame(()=>requestAnimationFrame(()=>webkit.messageHandlers.done.postMessage({ok:true})));}catch(e){webkit.messageHandlers.done.postMessage({ok:false,error:String(e)})}})();true
    """
    self.controls.forEach { $0.isHidden=true }
    self.web.evaluateJavaScript(script) {_,error in if let error {self.fail("js: \(error)")}}
   }catch {self.fail("read: \(error)")}
  }
 }
 func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
  let end=clockMS();guard let body=message.body as? [String:Any],body["ok"] as? Bool == true else {fail("web decode: \(message.body)");return}
  rows.append(["mode":runMode,"trial":trial,"total_ms":end-started,"prepare_ms":prepared-started,"encode_ms":encodeMS,"encode_span_ms":lastEncode-firstEncode,"rgba_ms":convertMS,"web_ms":end-prepared,"bytes":lastBytes,"warmup_png_sha256":hashes,"peak_workers":peakEncodes,"sampled_resident_delta_bytes":sampledResident>=residentBase ? sampledResident-residentBase : 0])
  snapshots.release(lastToken);next()
 }
 func fail(_ error:String) {try? error.write(to:out.appendingPathComponent("error.txt"),atomically:true,encoding:.utf8);print("FAILED \(error)");exit(1)}
 func finish() {
  try! JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent("screen-results.json"))
  print("SCREEN BENCH complete");fflush(stdout)
 }
}
