import UIKit
import WebKit

let pipelineCounterLock = NSLock()
var rasterCaptures = 0
var pngEncodes = 0
var pngWrites = 0
var nativeDecodes = 0
var fileReads = 0

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
        for (index, button) in controls.enumerated() {
            button.frame = CGRect(x: 20 + CGFloat(index % 2) * view.bounds.width / 2,
                                  y: top + CGFloat(index / 2) * pitch, width: view.bounds.width / 2 - 30,
                                  height: min(48, pitch - 8))
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            let url = Bundle.main.url(forResource: "pipeline", withExtension: "js")!
            self.web.evaluateJavaScript(try! String(contentsOf: url, encoding: .utf8))
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any], let key = value["key"] as? Int,
              let request = value["request"] as? [String: Any] else { return }
        let action = request["action"] as? String ?? ""
        let complete: (Any) -> Void = { result in
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
            let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("pipeline.json")
            try! JSONSerialization.data(withJSONObject: request, options: [.prettyPrinted, .sortedKeys]).write(to: path)
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
