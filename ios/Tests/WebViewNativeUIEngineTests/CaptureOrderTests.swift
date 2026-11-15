import XCTest
import UIKit
@testable import WebViewNativeUIEngine

@MainActor
final class CaptureOrderTests: XCTestCase {
    private final class MovingScroll: UIScrollView {
        var moving = true
        var stops = 0
        override var isDecelerating: Bool { moving }
        override func setContentOffset(_ point: CGPoint, animated: Bool) {
            stops += 1
            moving = false
            super.setContentOffset(point, animated: animated)
        }
    }

    private final class CaptureButton: UIButton {
        var draws = 0
        var beforeDraw: (() -> Void)?
        override func drawHierarchy(in rect: CGRect, afterScreenUpdates: Bool) -> Bool {
            beforeDraw?()
            draws += 1
            UIColor.blue.setFill()
            UIRectFill(rect)
            return true
        }
    }

    func testNativeContactStopsBeforeRendererOnlyPixels() async throws {
        try await check(stop: true, nativeContact: true, viewCapture: true)
    }
    func testNativeContactStopsBeforeFreshMeasurementAndPixelsButIdleDoesNotStop() async throws {
        try await check(stop: true, nativeContact: true)
    }
    func testOptOutRetainsMomentumDuringCapture() async throws {
        try await check(stop: false, nativeContact: true)
    }
    func testWebContactDoesNotCancelUnrelatedMomentum() async throws {
        try await check(stop: true, nativeContact: false)
    }

    private func check(stop: Bool, nativeContact: Bool, viewCapture: Bool = false) async throws {
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        let web = try XCTUnwrap(window.rootViewController?.view)
        let scroll = MovingScroll(frame: web.bounds)
        let nested = MovingScroll(frame: CGRect(x: 0, y: 0, width: 100, height: 300))
        web.addSubview(scroll)
        scroll.addSubview(nested)
        let button = CaptureButton(frame: CGRect(x: 40, y: 100, width: 60, height: 44))
        web.addSubview(button)
        scroll.stops = 0; nested.stops = 0
        scroll.moving = true; nested.moving = true
        let snapshots = NativeUICoveredSnapshots()
        snapshots.observeInteractions(window) { _ in }
        defer { snapshots.reset(); window.isHidden = true }
        var measurements: [Bool] = []
        let shouldStop = stop && nativeContact
        let beforeDraw = {
            XCTAssertEqual(scroll.moving, !shouldStop)
            XCTAssertEqual(nested.moving, !shouldStop)
            XCTAssertEqual(measurements.last, !shouldStop)
        }
        window.beforeDraw = beforeDraw
        button.beforeDraw = beforeDraw
        let result: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.handle(["action": "prepare", "captureMode": viewCapture ? "view" : "window", "ids": ["button"], "revision": 1,
                              "viewportWidth": Double(web.bounds.width), "captureID": "ordered",
                              "stopScrollBeforeCapture": stop], in: web, frames: { _, _ in
                measurements.append(scroll.moving)
                return ["button": button.frame]
            }, views: { _ in [button] }) { continuation.resume(returning: $0) }
            XCTAssertEqual(window.draws + button.draws, 0)
            XCTAssertTrue(scroll.moving)
            XCTAssertTrue(nested.moving)
            if stop {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                    XCTAssertEqual(window.draws + button.draws, 0)
                    XCTAssertTrue(scroll.moving)
                    snapshots.pinBeforeInteraction(touchedViews: [nativeContact ? button : scroll])
                }
            } else {
                snapshots.pinBeforeInteraction(touchedViews: [button])
            }
        }
        XCTAssertNotNil(result["token"])
        XCTAssertGreaterThan(window.draws + button.draws, 0)
        XCTAssertEqual(scroll.stops, shouldStop ? 1 : 0)
        XCTAssertEqual(nested.stops, shouldStop ? 1 : 0)
        XCTAssertTrue(scroll.isScrollEnabled)
        XCTAssertTrue(nested.isScrollEnabled)
        let parts = try XCTUnwrap(result["parts"] as? [[String: Any]])
        let path = try XCTUnwrap(parts.first?["url"] as? String)
        XCTAssertNotNil(UIImage(contentsOfFile: try XCTUnwrap(URL(string: path)).path)?.cgImage)
    }

    func testStableIdleCaptureCompletesWithoutContactOrStopping() async throws {
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        let web = try XCTUnwrap(window.rootViewController?.view)
        let scroll = MovingScroll(frame: web.bounds)
        web.addSubview(scroll)
        scroll.moving = false
        scroll.stops = 0
        let snapshots = NativeUICoveredSnapshots()
        snapshots.observeInteractions(window) { _ in }
        defer { snapshots.reset(); window.isHidden = true }
        let result: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.handle(["action": "prepare", "ids": ["button"], "revision": 1,
                              "viewportWidth": Double(web.bounds.width), "captureID": "idle",
                              "stopScrollBeforeCapture": true], in: web,
                             frames: { _, _ in ["button": CGRect(x: 0, y: 0, width: 60, height: 44)] },
                             views: { _ in [scroll] }) { continuation.resume(returning: $0) }
        }
        XCTAssertNotNil(result["token"])
        XCTAssertGreaterThan(window.draws, 0)
        XCTAssertEqual(scroll.stops, 0)
    }

    func testStopRequestWithoutRegisteredPreinteractionWindowFailsWithoutStopping() {
        let web = UIView(frame: CGRect(x: 0, y: 0, width: 200, height: 300))
        let scroll = MovingScroll(frame: web.bounds)
        web.addSubview(scroll)
        scroll.stops = 0
        let snapshots = NativeUICoveredSnapshots()
        var completed = false
        snapshots.handle(["action": "prepare", "ids": ["button"], "revision": 1,
                          "viewportWidth": 200.0, "captureID": "missing", "stopScrollBeforeCapture": true],
                         in: web, frames: { _, _ in ["button": CGRect(x: 0, y: 0, width: 60, height: 44)] },
                         views: { _ in [scroll] }) { result in
            XCTAssertNil(result["token"])
            completed = true
        }
        XCTAssertTrue(completed)
        XCTAssertEqual(scroll.stops, 0)
    }
}
