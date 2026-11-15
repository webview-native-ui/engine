// Test fixtures fail immediately when required setup values are missing.
// swiftlint:disable force_unwrapping force_cast
import XCTest
import WebKit
@testable import WebViewNativeUIEngine

final class NativeUIScrollTrackerTests: XCTestCase {
    @MainActor func testTouchesResolveOnlyTheirNativeAndWebScrollOwners() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let web = WKWebView(frame: window.bounds)
        window.addSubview(web)
        let first = UIScrollView(frame: CGRect(x: 0, y: 0, width: 160, height: 300))
        let second = UIScrollView(frame: CGRect(x: 160, y: 0, width: 160, height: 300))
        let article = UIView()
        let unrelated = UIView()
        web.addSubview(first)
        web.addSubview(second)
        first.addSubview(article)
        web.addSubview(unrelated)
        let firstHost = try XCTUnwrap(NativeUIScrollHosting(webView: web, scrollView: first))
        let secondHost = try XCTUnwrap(NativeUIScrollHosting(webView: web, scrollView: second))
        let advertisement = UIView()
        let otherAd = UIView()
        XCTAssertTrue(firstHost.place(advertisement, frame: CGRect(x: 0, y: 0, width: 160, height: 100)))
        XCTAssertTrue(secondHost.place(otherAd, frame: CGRect(x: 160, y: 0, width: 160, height: 100)))
        let nativeScroll = try XCTUnwrap(advertisement.superview as? UIScrollView)
        let otherNativeScroll = try XCTUnwrap(otherAd.superview as? UIScrollView)
        XCTAssertEqual(NativeUIScrollHosting.scrollViews(for: advertisement), [nativeScroll, first])
        XCTAssertEqual(NativeUIScrollHosting.scrollViews(for: article), [nativeScroll, first])
        XCTAssertEqual(NativeUIScrollHosting.scrollViews(for: first), [nativeScroll, first])
        XCTAssertEqual(NativeUIScrollHosting.scrollViews(for: second), [otherNativeScroll, second])
        XCTAssertTrue(NativeUIScrollHosting.scrollViews(for: unrelated).isEmpty)
        XCTAssertTrue(NativeUIScrollHosting.scrollViews(for: window).isEmpty)
        withExtendedLifetime([firstHost, secondHost]) {}
    }

    @MainActor func testRehostingRestoresOriginalRendererParent() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let owner = UIViewController()
        window.rootViewController = owner
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = WKWebView(frame: window.bounds)
        owner.view.addSubview(web)
        let rendererParent = UIView(frame: owner.view.bounds)
        owner.view.addSubview(rendererParent)
        let first = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 300))
        let second = UIScrollView(frame: CGRect(x: 0, y: 300, width: 320, height: 300))
        for scroll in [first, second] {
            scroll.contentSize = CGSize(width: 320, height: 1200)
            web.addSubview(scroll)
        }
        let sdk = UIView(frame: CGRect(x: 10, y: 20, width: 100, height: 60))
        rendererParent.addSubview(sdk)
        var a: NativeUIScrollHosting? = try XCTUnwrap(NativeUIScrollHosting(webView: web, scrollView: first))
        var b: NativeUIScrollHosting? = try XCTUnwrap(NativeUIScrollHosting(webView: web, scrollView: second))
        XCTAssertTrue(a!.place(sdk, frame: CGRect(x: 10, y: 20, width: 100, height: 60)))
        XCTAssertTrue(b!.place(sdk, frame: CGRect(x: 10, y: 320, width: 100, height: 60)))
        let currentParent = sdk.superview
        a = nil
        XCTAssertTrue(sdk.superview === currentParent)
        b = nil
        XCTAssertTrue(sdk.superview === rendererParent, "Rebinding must preserve the original renderer parent")
    }

    @MainActor func testRetiringHostReturnsRendererViewsWithoutShowingHiddenContent() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let web = WKWebView(frame: window.bounds)
        window.addSubview(web)
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 80, width: 320, height: 500))
        scroll.contentSize = CGSize(width: 320, height: 1200)
        web.addSubview(scroll)
        let view = UIView()
        window.addSubview(view)
        var host = try XCTUnwrap(NativeUIScrollHosting(webView: web, scrollView: scroll)) as NativeUIScrollHosting?
        XCTAssertTrue(host!.place(view, frame: CGRect(x: 10, y: 200, width: 240, height: 100)))
        scroll.contentOffset.y = 50
        let frame = view.convert(view.bounds, to: window)
        view.isHidden = true
        host = nil
        XCTAssertTrue(NativeUIScrollHosting.scrollViews(in: web).isEmpty)
        XCTAssertTrue(view.superview === window)
        XCTAssertEqual(view.frame, frame)
        XCTAssertTrue(view.isHidden)
    }

    @MainActor func testHostingPreservesContentCoordinatesAndTouchAncestry() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let owner = UIViewController()
        window.rootViewController = owner
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = WKWebView(frame: window.bounds)
        owner.view.addSubview(web)
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 80, width: 320, height: 500))
        scroll.contentSize = CGSize(width: 320, height: 1200)
        web.addSubview(scroll)
        let surface = UIView()
        let control = UIButton(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
        surface.addSubview(control)
        owner.view.addSubview(surface)
        let tracker = try XCTUnwrap(NativeUIScrollTracker(webView: web, nodes: [node()], scale: 1) { _, _, _ in })
        let frame = CGRect(x: 10, y: 200, width: 240, height: 100)
        XCTAssertTrue(tracker.host(surface, frame: frame))
        let nativeScroll = try XCTUnwrap(surface.superview as? UIScrollView)
        XCTAssertFalse(nativeScroll === scroll)
        XCTAssertFalse(nativeScroll.isDescendant(of: web), "WebKit must not intercept native SDK touches")
        XCTAssertTrue(NativeUIScrollHosting.scrollViews(in: web).contains { $0 === nativeScroll },
                      "Snapshot motion checks and cancellation must include the sibling surface")
        XCTAssertEqual(surface.convert(surface.bounds, to: web), frame)
        XCTAssertTrue(surface.hitTest(CGPoint(x: 20, y: 20), with: nil) === control, "SDK controls must retain tap ownership")
        XCTAssertTrue(owner.view.hitTest(CGPoint(x: 20, y: 210), with: nil) === control)
        XCTAssertNil(nativeScroll.hitTest(CGPoint(x: 300, y: 10), with: nil), "Empty overlay space must pass through")
        let contentFrame = surface.frame
        scroll.contentOffset.y = 100
        XCTAssertTrue(tracker.host(surface, frame: frame.offsetBy(dx: 0, dy: -100)))
        XCTAssertEqual(surface.frame, contentFrame, "Scrolling must keep the view in content coordinates")
        nativeScroll.contentOffset.y = 200
        XCTAssertEqual(scroll.contentOffset.y, 200, "Native pans must scroll the real overflow owner")
        XCTAssertFalse(tracker.host(web, frame: frame), "Never create a view ancestry cycle")
        XCTAssertFalse(tracker.host(owner.view, frame: frame))
        XCTAssertFalse(tracker.host(scroll, frame: frame))
        XCTAssertFalse(tracker.host(surface, frame: .null))
        scroll.removeFromSuperview()
        XCTAssertFalse(tracker.host(surface, frame: frame), "Detached scrollers cannot host new placements")
    }

    private func node(_ id: String = "counter", y: Double = 400, reuse: Bool = false) throws -> NativeUIScrollNode {
        let value: [String: Any] = ["id": id,
                                    "scroll": ["id": "scroll", "reuse": reuse, "offsetX": 0, "offsetY": 0,
                                               "viewport": ["x": 0, "y": 80, "width": 320, "height": 500],
                                               "clip": ["x": 0, "y": 100, "width": 320, "height": 480],
                                               "contentWidth": 320, "contentHeight": 1200,
                                               "frame": ["x": 10, "y": y, "width": 240, "height": 60]]]
        return try JSONDecoder().decode(NativeUIScrollNode.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @MainActor func testSharedScrollClippingAndTeardown() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let owner = UIViewController()
        window.rootViewController = owner
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = WKWebView(frame: window.bounds)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        owner.view.addSubview(web)
        let scroll = TrackingScrollView(frame: CGRect(x: 0, y: 80, width: 320, height: 500))
        scroll.contentSize = CGSize(width: 320, height: 1200)
        web.addSubview(scroll)
        let controller = NativeUIClippedView(content: UIView())
        owner.view.addSubview(controller)
        var updates = 0
        var frames: [String: CGRect] = [:]
        var tracker: NativeUIScrollTracker? = try XCTUnwrap(NativeUIScrollTracker(
            webView: web, nodes: [node(), node("second", y: 600)], scale: 1) { id, frame, clip in
            updates += 1
            frames[id] = frame
            if id == "counter" { controller.place(frame, clip: clip) }
        })
        tracker?.update()
        XCTAssertEqual(frames["counter"], CGRect(x: 10, y: 480, width: 240, height: 60))
        scroll.contentOffset.y = 420
        XCTAssertEqual(frames["counter"], CGRect(x: 10, y: 60, width: 240, height: 60))
        XCTAssertEqual(frames["second"], CGRect(x: 10, y: 260, width: 240, height: 60))
        XCTAssertEqual(controller.frame, CGRect(x: 10, y: 100, width: 240, height: 20))
        XCTAssertEqual(controller.content.frame, CGRect(x: 0, y: -40, width: 240, height: 60))
        XCTAssertNil(controller.hitTest(CGPoint(x: 5, y: -1), with: nil))
        scroll.moving = true
        XCTAssertTrue(try XCTUnwrap(tracker).replace([node(), node("second", y: 600)], webView: web, scale: 1))
        tracker?.update()
        XCTAssertEqual(frames["counter"]?.minY, 60, "Content updates must keep the original mapping during a gesture")
        scroll.moving = false
        // A delayed Web sample may arrive after dragging ends or during a JS
        // smooth scroll. Replacing content must not infer a new scroll origin.
        scroll.contentOffset.y = 430
        XCTAssertTrue(try XCTUnwrap(tracker).replace([node(), node("second", y: 600)], webView: web, scale: 1))
        tracker?.update()
        XCTAssertEqual(frames["counter"]?.minY, 50, "A delayed sample must not permanently shift native placement")
        scroll.contentOffset.y = 800
        XCTAssertTrue(controller.isHidden)
        scroll.contentOffset.y = 0
        XCTAssertFalse(controller.isHidden)
        tracker = nil
        let previous = updates
        scroll.contentOffset.y = 100
        XCTAssertEqual(updates, previous)
        scroll.contentOffset.y = 0
        let bindings = NativeUIScrollBindings()
        var oldUpdates = 0
        var replacementFrame: CGRect?
        XCTAssertTrue(try bindings.replace([node()], in: web, scale: 1) { _, _, _ in oldUpdates += 1 }.isEmpty)
        bindings.update()
        let oldCount = oldUpdates
        scroll.moving = true
        XCTAssertTrue(try bindings.replace([node(reuse: true)], in: web, scale: 1) { _, frame, _ in replacementFrame = frame }.isEmpty)
        scroll.contentOffset.y = 100
        XCTAssertEqual(oldUpdates, oldCount, "Reusing the observer must replace its renderer")
        XCTAssertEqual(replacementFrame?.minY, 380, "Keep the acquired coordinate origin while replacing the renderer")
        bindings.reset()
        scroll.moving = false
        let duplicate = UIScrollView(frame: scroll.frame)
        duplicate.contentSize = scroll.contentSize
        web.addSubview(duplicate)
        XCTAssertNil(NativeUIScrollTracker(webView: web, nodes: [try node()], scale: 1) { _, _, _ in })
    }

    @MainActor func testActualWebOverflowBinding() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let owner = UIViewController()
        window.rootViewController = owner
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = WKWebView(frame: window.bounds)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        owner.view.addSubview(web)
        web.loadHTMLString("""
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0}#scroll{position:absolute;top:80px;width:320px;height:500px;overflow:auto}#content{height:1200px}</style>
        <div id="scroll"><div id="content">Count</div></div>
        """, baseURL: nil)
        for _ in 0..<60 {
            if (try? await web.evaluateJavaScript("document.getElementById('scroll')?.clientHeight")) as? Int == 500 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        var tracker: NativeUIScrollTracker?
        var actual: CGRect?
        for _ in 0..<40 {
            tracker = NativeUIScrollTracker(webView: web, nodes: [try node()], scale: 1) { _, frame, _ in actual = frame }
            if tracker != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let bound = try XCTUnwrap(tracker, "Must bind to actual WebKit overflow")
        bound.update()
        let surface = UIView()
        let button = UIButton(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
        surface.addSubview(button)
        XCTAssertTrue(bound.host(surface, frame: try XCTUnwrap(actual)))
        XCTAssertTrue(owner.view.hitTest(CGPoint(x: 20, y: 490), with: nil) === button,
                      "A real overflow scroller must preserve native control hit testing")
        _ = try await web.evaluateJavaScript("document.getElementById('scroll').scrollTop = 150")
        for _ in 0..<40 {
            if actual?.minY == 330 { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertEqual(try XCTUnwrap(actual).minY, 330, accuracy: 0.5)
        XCTAssertEqual(surface.convert(surface.bounds, to: web).minY, 330, accuracy: 0.5)
        let nativeScroll = try XCTUnwrap(surface.superview as? UIScrollView)
        nativeScroll.contentOffset.y = 250
        var domOffset: Double?
        for _ in 0..<40 {
            domOffset = (try await web.evaluateJavaScript("document.getElementById('scroll').scrollTop") as? NSNumber)?.doubleValue
            if domOffset == 250 { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertEqual(try XCTUnwrap(domOffset), 250, accuracy: 0.5,
                       "Dragging native content must update the actual DOM scroll position")
        surface.removeFromSuperview()
    }
    @MainActor func testActualHorizontalScrollDirections() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let owner = UIViewController()
        window.rootViewController = owner
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = WKWebView(frame: window.bounds)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        owner.view.addSubview(web)
        for direction in ["ltr", "rtl"] {
            web.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{margin:0}#scroll{position:absolute;top:80px;width:300.5px;height:500px;border:.5px solid;overflow:auto;direction:\(direction)}#content{width:1200.25px;height:1200px}#source{width:240.25px;height:60px}</style>
            <div id="scroll"><div id="content"><div id="source">Count</div></div></div>
            """, baseURL: nil)
            try await Task.sleep(nanoseconds: 300_000_000)
            var value: Any?
            for _ in 0..<60 {
                value = try? await web.evaluateJavaScript("""
                (() => { const e=document.getElementById('source'), o=document.getElementById('scroll');
                if (!e || o.clientHeight !== 500 || getComputedStyle(o).direction !== '\(direction)') return null;
                const r=e.getBoundingClientRect(), b=o.getBoundingClientRect(), st=getComputedStyle(o);
                const l=parseFloat(st.borderLeftWidth), t=parseFloat(st.borderTopWidth);
                const v={x:b.x+l,y:b.y+t,width:b.width-l-parseFloat(st.borderRightWidth),height:b.height-t-parseFloat(st.borderBottomWidth)};
                return {id:'counter',kind:'extension',x:r.x,y:r.y,width:r.width,height:r.height,items:[],dark:false,rtl:false,
                  extension:{name:'counter',props:'{}',actions:{}},
                  scroll:{id:'scroll',offsetX:o.scrollLeft,offsetY:o.scrollTop,viewport:{x:v.x,y:v.y,width:v.width,height:v.height},
                  clip:{x:v.x,y:v.y,width:v.width,height:v.height},contentWidth:o.scrollWidth,contentHeight:o.scrollHeight,
                  frame:{x:r.x-v.x+o.scrollLeft,y:r.y-v.y+o.scrollTop,width:r.width,height:r.height}}}; })()
                """)
                if value is [String: Any] { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(value as? [String: Any]))
            let node = try JSONDecoder().decode(NativeUIScrollNode.self, from: data)
            var actual: CGRect?
            var tracker: NativeUIScrollTracker?
            for _ in 0..<40 {
                tracker = NativeUIScrollTracker(webView: web, nodes: [node], scale: 1) { _, frame, _ in actual = frame }
                if tracker != nil { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            let bound = try XCTUnwrap(tracker)
            bound.update()
            XCTAssertEqual(try XCTUnwrap(actual).minX, node.scroll!.frame.x + node.scroll!.viewport.x - node.scroll!.offsetX,
                           accuracy: 0.1, direction)
            _ = try await web.evaluateJavaScript("document.getElementById('scroll').scrollLeft = \(direction == "rtl" ? -150 : 150)")
            try await Task.sleep(nanoseconds: 200_000_000)
            let expected = try await web.evaluateJavaScript("document.getElementById('source').getBoundingClientRect().x") as! Double
            XCTAssertEqual(try XCTUnwrap(actual).minX, expected, accuracy: 0.1, direction)
        }
    }

}

private final class TrackingScrollView: UIScrollView {
    var moving = false
    override var isDragging: Bool { moving }
}

// swiftlint:enable force_unwrapping force_cast
