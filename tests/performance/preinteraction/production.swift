import UIKit
import WebKit

@main class ProductionApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { true }
}
class ProductionScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        let window = UIWindow(windowScene: scene as! UIWindowScene)
        window.rootViewController = CommandLine.arguments.contains("--planner") ? PlannerStudyScreen() : ProductionScreen()
        window.makeKeyAndVisible()
        self.window = window
    }
}
class ProductionFiles: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: task.request.url!.path))
            task.didReceive(URLResponse(url: task.request.url!, mimeType: "image/png", expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
class ProductionScreen: UIViewController, WKScriptMessageHandler {
    let snapshots = NativeUICoveredSnapshots()
    let toolbar = UIToolbar()
    let tabbar = UITabBar()
    var web: WKWebView!
    var rows: [[String: Any]] = []
    var reference: [Data] = []
    let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(ProductionFiles(), forURLScheme: "snapshot")
        config.userContentController.add(self, name: "bridge")
        web = WKWebView(frame: view.bounds, configuration: config)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(web)
        toolbar.items = [UIBarButtonItem(title: "Touch test", primaryAction: UIAction { [weak self] _ in
            self?.save(["manualAction": true])
        })]
        tabbar.items = [UITabBarItem(title: "Home", image: UIImage(systemName: "house"), tag: 0), UITabBarItem(title: "Search", image: UIImage(systemName: "magnifyingglass"), tag: 1)]
        tabbar.selectedItem = tabbar.items?.first
        view.addSubview(toolbar); view.addSubview(tabbar)
        let script = try! String(contentsOf: Bundle.main.url(forResource: "production", withExtension: "js")!, encoding: .utf8)
        web.loadHTMLString("""
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;background:repeating-linear-gradient(35deg,#9630de 0 12px,#19ccbd 12px 25px,#edc14e 25px 40px);height:100vh}#top,#bottom{position:absolute;left:0;width:100%;color:transparent}#top{top:80px;height:44px}#bottom{bottom:0;height:83px}</style>
        <div id="top">Toolbar</div><div id="bottom">Tab bar</div><script>\(script)</script>
        """, baseURL: URL(string: "https://fixture.local"))
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        web.frame = view.bounds
        toolbar.frame = CGRect(x: 0, y: 80, width: view.bounds.width, height: 44)
        tabbar.frame = CGRect(x: 0, y: view.bounds.height - 83, width: view.bounds.width, height: 83)
    }
    func evaluate(_ function: String, _ values: [Any]) {
        let bytes = try! JSONSerialization.data(withJSONObject: values)
        web.evaluateJavaScript("\(function)(...\(String(data: bytes, encoding: .utf8)!))", completionHandler: nil)
    }
    func save(_ value: [String: Any]) {
        rows.append(value)
        try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("production-results.json"))
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let key = body["key"] as? Int, let request = body["request"] as? [String: Any] else { return }
        let reply: ([String: Any]) -> Void = { [weak self] value in self?.evaluate("receive", [key, value]) }
        switch request["action"] as? String {
        case "record": save(request["data"] as! [String: Any]); reply([:])
        case "error": save(request); reply([:])
        case "layout": view.layoutIfNeeded(); reply([:])
        case "observe":
            snapshots.observeInteractions(view.window!) { [weak self] event in self?.evaluate("interaction", [event]) }
            reply([:])
        case "contact": snapshots.pinBeforeInteraction(); reply([:])
        case "done":
            save(["done": true]); reply([:])
            snapshots.reset()
            snapshots.observeInteractions(view.window!) { [weak self] event in self?.save(["manualEvent": event]) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.armManual() }
        default:
            if request["action"] as? String == "prepare" {
                snapshots.observeInteractions(view.window!) { [weak self] event in self?.evaluate("interaction", [event]) }
            }
            snapshots.handle(request, in: web, frames: { [weak self] _, _ in self?.frames() ?? [:] }, views: { [weak self] _ in
                guard let self else { return nil }; return [self.toolbar, self.tabbar]
            }, complete: reply)
        }
    }
    func armManual() {
        snapshots.prepare(frames: { [weak self] in self?.frames() ?? [:] }, in: web, viewportWidth: web.bounds.width,
                          captureID: "reference") { [weak self] result in
            guard let self else { return }
            self.reference = self.imageData(result)
            self.save(["manualReferenceParts": self.reference.count])
            self.snapshots.prepare(frames: { [weak self] in self?.frames() ?? [:] }, in: self.web, viewportWidth: self.web.bounds.width,
                                   captureID: "manual", delay: 60_000) { [weak self] result in
                guard let self else { return }
                self.save(["manualResult": result, "matchesReference": self.imageData(result) == self.reference])
            }
        }
    }
    func imageData(_ result: [String: Any]) -> [Data] {
        (result["parts"] as? [[String: Any]] ?? []).compactMap {
            guard let path = $0["url"] as? String, let url = URL(string: path) else { return nil }
            return try? Data(contentsOf: url)
        }
    }
    func frames() -> [String: CGRect] { ["top": toolbar.convert(toolbar.bounds, to: web), "bottom": tabbar.convert(tabbar.bounds, to: web)] }
}
