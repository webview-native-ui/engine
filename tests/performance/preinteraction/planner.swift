import UIKit
import WebKit
import CoreImage
import CryptoKit

final class PlannerStudyScreen: UIViewController, WKNavigationDelegate {
    var web: WKWebView!
    var controls: [UIView] = []
    var rows: [[String: Any]] = []
    let ci = CIContext()
    struct Scenario {
        let name: String
        let regions: [CGRect]
        var scales: [CGFloat] = [3]
        var viewMode = false
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        web = WKWebView(frame: view.bounds)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        view.addSubview(web)
        web.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0;height:100vh;background:repeating-linear-gradient(35deg,#9630de 0 12px,#19ccbd 12px 25px,#edc14e 25px 40px)}</style>", baseURL: nil)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); web.frame = view.bounds }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { Task { await run() } }
    func partitions(_ regions: [CGRect]) -> [[CGRect]] {
        let bands = NativeUICapturePlanner.bands(regions)
        return (0..<(1 << max(0, bands.count - 1))).map { mask in
            var groups = [bands[0]]
            for index in 1..<bands.count {
                if mask & (1 << (index - 1)) != 0 { groups.append(bands[index]) }
                else { groups[groups.count - 1] = groups.last!.union(bands[index]) }
            }
            return groups
        }
    }
    func capture(_ groups: [CGRect], regions: [CGRect], scale: CGFloat, viewMode: Bool) -> (Double, [CGImage]) {
        let start = CACurrentMediaTime()
        var images: [(CGRect, CGImage)] = []
        for rect in groups {
            let context = CGContext(data: nil, width: Int((rect.width * scale).rounded()), height: Int((rect.height * scale).rounded()),
                                    bitsPerComponent: 16, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.extendedDisplayP3)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder16Little.rawValue)!
            context.translateBy(x: 0, y: rect.height * scale)
            context.scaleBy(x: scale, y: -scale)
            context.translateBy(x: -rect.minX, y: -rect.minY)
            UIGraphicsPushContext(context)
            if viewMode {
                for root in controls { precondition(root.drawHierarchy(in: root.convert(root.bounds, to: view.window), afterScreenUpdates: true)) }
            } else { precondition(view.window!.drawHierarchy(in: view.window!.bounds, afterScreenUpdates: false)) }
            UIGraphicsPopContext()
            images.append((rect, context.makeImage()!))
        }
        let crops = regions.map { region in
            let (area, image) = images.first(where: { $0.0.contains(region) })!
            return image.cropping(to: CGRect(x: (region.minX - area.minX) * scale, y: (region.minY - area.minY) * scale,
                                             width: region.width * scale, height: region.height * scale))!
        }
        return ((CACurrentMediaTime() - start) * 1000, crops)
    }
    func hash(_ images: [CGImage]) -> [String] {
        images.map { image in
            var data = Data(count: image.width * image.height * 8)
            data.withUnsafeMutableBytes { bytes in
                ci.render(CIImage(cgImage: image), toBitmap: bytes.baseAddress!, rowBytes: image.width * 8,
                          bounds: CGRect(x: 0, y: 0, width: image.width, height: image.height), format: .RGBA16,
                          colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!)
            }
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
    }
    func install(_ scenario: Scenario) {
        controls.forEach { $0.removeFromSuperview() }; controls = []
        if scenario.name == "bars" {
            let toolbar = UIToolbar(frame: scenario.regions[0]); toolbar.items = [UIBarButtonItem(title: "Home", style: .plain, target: nil, action: nil)]
            let tabbar = UITabBar(frame: scenario.regions[1]); tabbar.items = [UITabBarItem(title: "Search", image: UIImage(systemName: "magnifyingglass"), tag: 0)]
            controls = [toolbar, tabbar]
        } else {
            controls = scenario.regions.enumerated().map { index, frame in
                let button = UIButton(frame: frame); var config = UIButton.Configuration.glass(); config.title = "\(index)"; button.configuration = config
                return button
            }
        }
        controls.forEach { view.addSubview($0) }; view.layoutIfNeeded()
    }
    func run() async {
        let width = view.bounds.width, height = view.bounds.height
        func rects(_ ys: [CGFloat], h: CGFloat, narrow: Bool = false) -> [CGRect] {
            ys.map { CGRect(x: narrow ? 100 : 0, y: $0, width: narrow ? 80 : width, height: h) }
        }
        let grid = [CGFloat(70), 170, 270, 370, 470, 590].flatMap { y in [CGFloat(12), width / 2 + 6].map { x in CGRect(x: x, y: y, width: width / 2 - 18, height: 32) } }
        var scenarios = [
            Scenario(name: "bars", regions: [CGRect(x: 0, y: 80, width: width, height: 44), CGRect(x: 0, y: height - 83, width: width, height: 83)], scales: [1, 2, 3]),
            Scenario(name: "two-close", regions: rects([80, 260], h: 44)),
            Scenario(name: "three", regions: rects([60, 325, 600], h: 20), scales: [1, 2, 3]),
            Scenario(name: "four", regions: rects([60, 240, 420, 600], h: 20)),
            Scenario(name: "six", regions: rects([60, 160, 260, 360, 460, 600], h: 20)),
            Scenario(name: "grid", regions: grid),
            Scenario(name: "narrow", regions: rects([80, 590], h: 44, narrow: true)),
            Scenario(name: "dense", regions: rects([80, 160, 240, 320], h: 44)),
            Scenario(name: "vertical", regions: rects([80, 590], h: 44) + [CGRect(x: 10, y: 60, width: 60, height: 570)])
        ]
        scenarios.append(Scenario(name: "view-two", regions: rects([80, 590], h: 44), viewMode: true))
        scenarios.append(Scenario(name: "view-grid", regions: grid, viewMode: true))
        let verifying = CommandLine.arguments.contains("--planner-verify")
        if verifying {
            scenarios = [
                Scenario(name: "bars", regions: [CGRect(x: 0, y: 80, width: width, height: 44), CGRect(x: 0, y: height - 83, width: width, height: 83)]),
                Scenario(name: "three-wide", regions: rects([24, 320, 616], h: 20)),
                Scenario(name: "two-clusters", regions: rects([30, 100, 510, 580], h: 30)),
                Scenario(name: "medium-width", regions: [80.0, 590].map { CGRect(x: 100, y: $0, width: 180, height: 44) }),
                Scenario(name: "narrow", regions: rects([80, 590], h: 44, narrow: true)),
                Scenario(name: "four", regions: rects([60, 240, 420, 600], h: 20)),
                Scenario(name: "view-two", regions: rects([80, 590], h: 44), viewMode: true),
                Scenario(name: "view-grid", regions: grid, viewMode: true)
            ]
        }
        for scenario in scenarios {
            install(scenario)
            try? await Task.sleep(nanoseconds: 400_000_000)
            for scale in scenario.scales {
                let regions = scenario.regions.map { $0.insetBy(dx: -12, dy: -12).intersection(view.window!.bounds) }
                let selected = NativeUICapturePlanner.plan(regions, scale: scale, drawsPerPass: scenario.viewMode ? controls.count : 1,
                                                           model: scenario.viewMode ? .viewDefault : .default,
                                                           windowWidth: width, nativeScale: view.window!.screen.scale)
                var plans = partitions(regions) + [[view.window!.bounds]]
                if verifying && scenario.name == "view-grid" { plans = [plans[0], plans[plans.count - 2], plans.last!] }
                var reference: [String]?
                for trial in 0..<12 {
                    for offset in plans.indices {
                        let index = (offset + trial) % plans.count
                        let groups = plans[index]
                        let (ms, images) = capture(groups, regions: regions, scale: scale, viewMode: scenario.viewMode)
                        var row: [String: Any] = ["scenario": scenario.name, "scale": scale, "viewMode": scenario.viewMode,
                            "trial": trial, "plan": index, "groups": groups.map { [$0.minX, $0.minY, $0.width, $0.height] },
                            "regions": regions.map { [$0.minX, $0.minY, $0.width, $0.height] },
                            "passes": groups.count, "draws": groups.count * (scenario.viewMode ? controls.count : 1),
                            "megapixels": groups.reduce(CGFloat.zero) { $0 + $1.width * $1.height * scale * scale / 1_000_000 },
                            "acquisitionMs": ms, "fullWindow": index == plans.count - 1, "selected": groups == selected]
                        if trial == 0 {
                            let digest = hash(images)
                            if index == 0 { reference = digest }
                            row["pixelsMatchUnion"] = digest == reference
                            if digest != reference {
                                row["repeatUnionMatchesInitial"] = hash(capture([regions.reduce(CGRect.null) { $0.union($1) }], regions: regions,
                                                                              scale: scale, viewMode: scenario.viewMode).1) == reference
                            }
                        }
                        rows.append(row)
                        try? await Task.sleep(nanoseconds: 1_000_000)
                    }
                }
                save()
            }
        }
        rows.append(["done": true]); save()
    }
    func save() {
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("planner-results.json")
        try! JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]).write(to: output, options: .atomic)
    }
}
