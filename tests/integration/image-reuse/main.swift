import UIKit
import WebKit

let pipelineCounterLock = NSLock()
var rasterCaptures = 0
var pngEncodes = 0
var pngWrites = 0
var nativeDecodes = 0
var fileReads = 0
var pipelineStages: [String: Double] = [:]
func pipelineStage(_ name: String) {
    pipelineCounterLock.lock(); defer { pipelineCounterLock.unlock() }
    pipelineStages[name] = CACurrentMediaTime()
}

@main class App: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { true }
}
class Scene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        let window = UIWindow(windowScene: scene as! UIWindowScene)
        window.rootViewController = Screen()
        window.makeKeyAndVisible()
        self.window = window
    }
}
class Images: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: task.request.url!.path))
            fileReads += 1
            task.didReceive(URLResponse(url: task.request.url!, mimeType: "image/png", expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
class Screen: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    var web: WKWebView!
    let snapshots = NativeUICoveredSnapshots()
    var controls: [UIButton] = []
    var captureDirectory: URL?
    var bridgeTrace: [[String: Any]] = []
    var graphicsWarmupMs: Double = 0
    override func viewDidLoad() {
        super.viewDidLoad()
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(Images(), forURLScheme: "snapshot")
        configuration.userContentController.add(self, name: "bridge")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        view.addSubview(web)
        web.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;height:100vh;background:linear-gradient(135deg,#b7d8fa,#fff1cd);font:18px -apple-system'><h1 style='padding:80px 20px'>Image pipeline</h1></body>", baseURL: URL(string: "https://fixture.invalid"))
        for i in 0..<12 {
            var config = UIButton.Configuration.filled()
            config.baseBackgroundColor = .systemBlue
            config.title = ["Home", "Search", "Favorites", "Library"][i % 4]
            config.image = UIImage(systemName: "star.fill")
            config.imagePadding = 8
            let button = UIButton(configuration: config)
            controls.append(button); view.addSubview(button)
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        web.frame = view.bounds
        let top = max(140, view.bounds.height * 0.3)
        let pitch = min(62, (view.bounds.height - top - 60) / 6)
        // Keep twelve independent crops, but bound their pixels: this verifies
        // pipeline reuse/counts within the same deadlines on CI runners.
        for (index, button) in controls.enumerated() {
            button.frame = CGRect(x: 20 + CGFloat(index % 2) * view.bounds.width / 2,
                                  y: top + CGFloat(index / 2) * pitch, width: min(80, view.bounds.width / 2 - 30),
                                  height: min(32, pitch - 8))
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Initialize UIKit/CoreImage/ImageIO before testing an empty capture cache.
        // This fixture verifies reuse and cleanup, not graphics cold-start latency.
        let started = CACurrentMediaTime()
        var pending = true
        let timeout = DispatchWorkItem {
            guard pending else { return }
            pending = false
            self.record(["action": "failed", "phase": "graphics-warmup", "error": "warmup exceeded 30 seconds"])
            self.snapshots.reset()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
        snapshots.prepare(frames: {
            Dictionary(uniqueKeysWithValues: self.controls.enumerated().map {
                (String($0.offset), $0.element.convert($0.element.bounds, to: self.web))
            })
        }, in: web, viewportWidth: web.bounds.width, views: controls) { result in
            guard pending else { return }
            pending = false; timeout.cancel()
            guard let token = result["token"] as? String,
                  let parts = result["parts"] as? [[String: Any]], parts.count == 12 else {
                self.record(["action": "failed", "phase": "graphics-warmup", "error": "warmup did not produce twelve parts"])
                return
            }
            let files = parts.compactMap { ($0["url"] as? String).flatMap(URL.init(string:)) }
            guard files.count == 12, files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) else {
                self.record(["action": "failed", "phase": "graphics-warmup", "error": "warmup files missing"])
                return
            }
            self.snapshots.reset()
            guard self.snapshots.identifiers(for: token).isEmpty,
                  files.allSatisfy({ !FileManager.default.fileExists(atPath: $0.path) }) else {
                self.record(["action": "failed", "phase": "graphics-warmup", "error": "warmup images survived reset"])
                return
            }
            self.graphicsWarmupMs = (CACurrentMediaTime() - started) * 1000
            pipelineCounterLock.lock()
            rasterCaptures = 0; pngEncodes = 0; pngWrites = 0; nativeDecodes = 0; fileReads = 0
            pipelineStages.removeAll()
            pipelineCounterLock.unlock()
            let url = Bundle.main.url(forResource: "pipeline", withExtension: "js")!
            self.web.evaluateJavaScript(try! String(contentsOf: url, encoding: .utf8))
        }
    }
    func record(_ request: [String: Any]) {
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("pipeline.json")
        var output = request
        output["graphicsWarmupMs"] = graphicsWarmupMs
        if request["action"] as? String == "failed" {
            pipelineCounterLock.lock()
            output["nativeCounters"] = ["captures": rasterCaptures, "encodes": pngEncodes, "writes": pngWrites,
                                        "nativeDecodes": nativeDecodes, "fileReads": fileReads]
            output["nativeStages"] = pipelineStages
            pipelineCounterLock.unlock()
            output["nativeTrace"] = bridgeTrace
        }
        try! JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]).write(to: path)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any], let key = value["key"] as? Int,
              let request = value["request"] as? [String: Any] else { return }
        let action = request["action"] as? String ?? ""
        let receivedAt = CACurrentMediaTime()
        bridgeTrace.append(["key": key, "action": action, "receivedAt": receivedAt])
        let complete: (Any) -> Void = { result in
            self.bridgeTrace.append(["key": key, "action": action, "elapsedMs": (CACurrentMediaTime() - receivedAt) * 1000])
            let json = try! JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
            let text = String(data: json, encoding: .utf8)!
            self.web.evaluateJavaScript("window.reply(\(key),\(text));true")
        }
        if action == "accept-native" {
            snapshots.restoreControls(); snapshots.finishCovering()
            complete([:]); return
        }
        if action == "move" {
            controls.forEach { $0.transform.ty += 2 }
        }
        if action == "frames" || action == "move" {
            complete(controls.map { button in
                let frame = button.convert(button.bounds, to: web)
                return ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            }); return
        }
        if action == "metrics" {
            let files = captureDirectory.flatMap { try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) } ?? []
            complete(["captures": rasterCaptures, "encodes": pngEncodes, "writes": pngWrites,
                      "nativeDecodes": nativeDecodes, "fileReads": fileReads, "files": files.count]); return
        }
        if action == "content" {
            var config = controls[0].configuration
            config?.title = "Updated"
            controls[0].configuration = config
            complete([:]); return
        }
        if action == "done" || action == "failed" {
            record(request)
            complete([:]); return
        }
        snapshots.handle(request, in: web, frames: { ids, _ in
            Dictionary(uniqueKeysWithValues: ids.compactMap { id in
                guard let index = Int(id), self.controls.indices.contains(index) else { return nil }
                let control = self.controls[index]
                return (id, control.convert(control.bounds, to: self.web))
            })
        }, views: { ids in
            ids.sorted().compactMap { id in Int(id).flatMap { self.controls.indices.contains($0) ? self.controls[$0] : nil } }
        }) { result in
            if let parts = result["parts"] as? [[String: Any]], let path = parts.first?["url"] as? String {
                self.captureDirectory = URL(string: path)?.deletingLastPathComponent()
            }
            complete(result)
        }
    }
}
