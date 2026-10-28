import XCTest
import UIKit
@testable import WebViewNativeUIEngine

final class NativeUICoveredSnapshotsTests: XCTestCase {
    @MainActor func testPreparedImageContainsVisibleWindowPixels() async throws {
        let owner = UIViewController()
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.rootViewController = owner
        window.makeKeyAndVisible()
        let view = owner.view!
        view.frame = window.bounds
        window.layoutIfNeeded()
        let snapshots = NativeUICoveredSnapshots()
        defer { snapshots.reset(); window.isHidden = true }
        let result: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.prepare(frames: { ["control": CGRect(x: 20, y: 80, width: 48, height: 48)] },
                              in: view, viewportWidth: view.bounds.width) { continuation.resume(returning: $0) }
        }
        let parts = try XCTUnwrap(result["parts"] as? [[String: Any]])
        let path = try XCTUnwrap(parts.first?["url"] as? String)
        let url = try XCTUnwrap(URL(string: path))
        let image = try XCTUnwrap(UIImage(contentsOfFile: url.path)?.cgImage)
        XCTAssertEqual(image.bitsPerComponent, 16, "PNG must retain 16-bit channel precision")
        XCTAssertEqual(image.colorSpace?.name, CGColorSpace.displayP3, "PNG must carry its Display P3 profile")
        XCTAssertEqual(image.width, Int(72 * window.screen.scale))
        XCTAssertEqual(image.height, Int(72 * window.screen.scale))
        var pixel = [UInt8](repeating: 0, count: 4)
        let drawn = pixel.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1,
                bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        XCTAssertTrue(drawn)
        XCTAssertTrue(pixel.prefix(3).allSatisfy { $0 > 240 },
                      "A successful preparation must contain the white window pixels, not a black display replica")
    }

    @MainActor func testCapturePreservesCropPositionAndOrientation() async throws {
        let owner = UIViewController()
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.pattern = true
        window.rootViewController = owner
        window.makeKeyAndVisible()
        let view = owner.view!
        view.frame = window.bounds
        window.layoutIfNeeded()
        let snapshots = NativeUICoveredSnapshots()
        defer { snapshots.reset(); window.isHidden = true }
        let result: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.prepare(frames: { ["control": CGRect(x: 20, y: 80, width: 48, height: 48)] },
                              in: view, viewportWidth: view.bounds.width) { continuation.resume(returning: $0) }
        }
        let token = try XCTUnwrap(result["token"] as? String)
        let parts = try XCTUnwrap(result["parts"] as? [[String: Any]])
        let url = try XCTUnwrap(URL(string: try XCTUnwrap(parts.first?["url"] as? String)))
        let image = try XCTUnwrap(UIImage(contentsOfFile: url.path)?.cgImage)
        for (fraction, channel) in [(0.25, 0), (0.75, 2)] {
            let sample = try XCTUnwrap(image.cropping(to: CGRect(x: image.width / 2, y: Int(Double(image.height) * fraction), width: 1, height: 1)))
            var rgba = [UInt8](repeating: 0, count: 4)
            rgba.withUnsafeMutableBytes { bytes in
                let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                    bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(sample, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            XCTAssertGreaterThan(rgba[channel], 240)
            XCTAssertLessThan(rgba[2 - channel], 10, "Capture must keep top red and bottom blue at the requested crop")
        }
        XCTAssertTrue(snapshots.cover(token, in: view, views: []))
        let copy = try XCTUnwrap(window.subviews.compactMap { $0 as? UIImageView }.first?.image?.cgImage)
        XCTAssertFalse(copy.bitmapInfo.contains(.floatComponents), "Native handoff must use encoded PNG pixels, not the pre-conversion Float16 crop")
        XCTAssertEqual(copy.bitsPerComponent, image.bitsPerComponent)
        XCTAssertEqual(copy.colorSpace?.name, image.colorSpace?.name)
        XCTAssertEqual(copy.dataProvider?.data as Data?, image.dataProvider?.data as Data?,
                       "Native and Web handoff copies must share the same decoded PNG pixels")
        snapshots.release(token)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    @MainActor func testCaptureRetainsSubEightBitColorDifferences() async throws {
        let owner = UIViewController()
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.precisionPattern = true
        window.rootViewController = owner
        window.makeKeyAndVisible()
        let view = owner.view!
        view.frame = window.bounds
        window.layoutIfNeeded()
        let snapshots = NativeUICoveredSnapshots()
        defer { snapshots.reset(); window.isHidden = true }
        let result: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.prepare(frames: { ["control": CGRect(x: 20, y: 80, width: 48, height: 48)] },
                              in: view, viewportWidth: view.bounds.width) { continuation.resume(returning: $0) }
        }
        let parts = try XCTUnwrap(result["parts"] as? [[String: Any]])
        let path = try XCTUnwrap(parts.first?["url"] as? String)
        let image = try XCTUnwrap(UIImage(contentsOfFile: try XCTUnwrap(URL(string: path)).path)?.cgImage)
        var samples: [Float] = []
        for fraction in [0.25, 0.75] {
            let sample = try XCTUnwrap(image.cropping(to: CGRect(x: Int(Double(image.width) * fraction), y: image.height / 2, width: 1, height: 1)))
            var rgba = [Float](repeating: 0, count: 4)
            try rgba.withUnsafeMutableBytes { bytes in
                let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: 1, height: 1,
                    bitsPerComponent: 32, bytesPerRow: 16, space: CGColorSpace(name: CGColorSpace.extendedDisplayP3)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder32Little.rawValue))
                context.draw(sample, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            samples.append(rgba[0])
        }
        // Both input values round to 128/255 at 8-bit precision.
        XCTAssertEqual(samples[0], 0.5003, accuracy: 0.0003)
        XCTAssertEqual(samples[1], 0.5008, accuracy: 0.0003)
        XCTAssertGreaterThan(samples[1] - samples[0], 0.0002)
    }

    @MainActor func testMovingModalCaptureAndReturnDoNotReplaceBackgroundOwnership() async throws {
        let owner = UIViewController()
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.rootViewController = owner
        window.makeKeyAndVisible()
        let view = owner.view!
        view.frame = window.bounds
        window.layoutIfNeeded()
        let snapshots = NativeUICoveredSnapshots()
        defer { snapshots.reset(); window.isHidden = true }
        func capture(_ id: String) async -> [String: Any] {
            await withCheckedContinuation { continuation in
                snapshots.prepare(frames: { [id: CGRect(x: 20, y: 80, width: 48, height: 48)] },
                                  in: view, viewportWidth: view.bounds.width) { continuation.resume(returning: $0) }
            }
        }
        let backCapture = await capture("back")
        let background = try XCTUnwrap(backCapture["token"] as? String)
        XCTAssertTrue(snapshots.cover(background, in: view, views: []))
        let modalCapture = await capture("modal")
        let foreground = try XCTUnwrap(modalCapture["token"] as? String)
        XCTAssertTrue(snapshots.cover(foreground, in: view, views: [], transient: true))
        XCTAssertEqual(snapshots.coveringToken, background)
        snapshots.retireCopy(foreground)
        let destination = CGRect(x: 8, y: 320, width: 72, height: 72)
        XCTAssertTrue(snapshots.restore(in: view, token: foreground, frames: ["modal": destination]))
        snapshots.retireCopy(foreground)
        let returned = try XCTUnwrap(window.subviews.compactMap { $0 as? UIImageView }.first)
        XCTAssertEqual(returned.frame, view.convert(destination, to: window))
        snapshots.retireCopy(foreground, entry: false)
        XCTAssertNil(returned.superview)
        XCTAssertEqual(snapshots.identifiers(for: foreground), ["modal"], "Retiring a return copy must preserve its reusable capture")
        XCTAssertTrue(snapshots.cover(foreground, in: view, views: [], transient: true, frames: ["modal": destination]))
        XCTAssertEqual(window.subviews.compactMap { $0 as? UIImageView }.first?.frame, view.convert(destination, to: window),
                       "A repeated cover must use the restored position without a new capture")
        snapshots.retireCopy(foreground, entry: false)
        XCTAssertFalse(window.subviews.compactMap { $0 as? UIImageView }.isEmpty, "An old return acknowledgement cannot remove a new entry copy")
        snapshots.release(foreground)
        XCTAssertTrue(window.subviews.compactMap { $0 as? UIImageView }.isEmpty)
        XCTAssertEqual(snapshots.coveringToken, background)
        XCTAssertEqual(snapshots.identifiers(for: background), ["back"])
    }

    @MainActor func testCoverHidesOnlyItsViewsAndOldReturnTimerCannotOrphanNewCopy() async throws {
        let owner = UIViewController()
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        window.rootViewController = owner
        window.makeKeyAndVisible()
        let view = owner.view!
        view.backgroundColor = .white
        view.frame = window.bounds
        window.layoutIfNeeded()
        let snapshots = NativeUICoveredSnapshots()
        defer { snapshots.reset(); window.isHidden = true }
        let capture: [String: Any] = await withCheckedContinuation { continuation in
            snapshots.prepare(frames: { ["button": CGRect(x: 20, y: 80, width: 60, height: 44)] },
                              in: view, viewportWidth: view.bounds.width) { continuation.resume(returning: $0) }
        }
        let token = try XCTUnwrap(capture["token"] as? String)
        let visible = UIView(), hidden = UIView()
        hidden.isHidden = true
        XCTAssertFalse(snapshots.cover("missing", in: view, views: [visible]))
        XCTAssertFalse(visible.isHidden, "Failed cover must not mutate visibility")
        XCTAssertTrue(snapshots.cover(token, in: view, views: [visible, hidden]))
        XCTAssertTrue(visible.isHidden)
        XCTAssertTrue(hidden.isHidden)
        snapshots.release("stale-token")
        XCTAssertTrue(visible.isHidden)
        XCTAssertFalse(window.subviews.compactMap { $0 as? UIImageView }.isEmpty)
        snapshots.retireCopy("stale-token")
        XCTAssertFalse(window.subviews.compactMap { $0 as? UIImageView }.isEmpty)
        snapshots.retireCopy(token)
        XCTAssertTrue(window.subviews.compactMap { $0 as? UIImageView }.isEmpty)
        XCTAssertTrue(snapshots.restore(in: view))
        snapshots.finishCovering()
        snapshots.retireCopy(token)
        XCTAssertFalse(window.subviews.compactMap { $0 as? UIImageView }.isEmpty,
                       "A delayed entry acknowledgement must not remove the return copy")
        snapshots.cover(token, in: view, views: [visible, hidden])
        // A second return copy must not be retired by the first copy's timer.
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(snapshots.restore(in: view))
        let returned = try XCTUnwrap(window.subviews.compactMap { $0 as? UIImageView }.first)
        XCTAssertTrue(returned.superview === window)
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertTrue(returned.superview === window)
        snapshots.restoreControls()
        XCTAssertFalse(visible.isHidden)
        XCTAssertTrue(hidden.isHidden)
        visible.isHidden = true // A normal native update now owns visibility.
        snapshots.release(token)
        XCTAssertTrue(visible.isHidden)
        XCTAssertNil(returned.superview, "An old timer must not orphan the newer copy")
        XCTAssertTrue(window.subviews.compactMap { $0 as? UIImageView }.isEmpty)
    }
}

// Swift package tests have no hosted application scene. Supply deterministic
// pixels here; actual UIKit capture is also verified in hosted device integration tests.
final class SnapshotTestWindow: UIWindow {
    var pattern = false
    var precisionPattern = false
    override func drawHierarchy(in rect: CGRect, afterScreenUpdates: Bool) -> Bool {
        UIColor.white.setFill()
        UIRectFill(rect)
        if pattern {
            UIColor.red.setFill()
            UIRectFill(CGRect(x: 8, y: 68, width: 72, height: 36))
            UIColor.blue.setFill()
            UIRectFill(CGRect(x: 8, y: 104, width: 72, height: 36))
        }
        if precisionPattern {
            let context = UIGraphicsGetCurrentContext()!
            let space = CGColorSpace(name: CGColorSpace.extendedDisplayP3)!
            for (x, red) in [(8.0, 0.5003), (44.0, 0.5008)] {
                context.setFillColor(CGColor(colorSpace: space, components: [red, 0.25, 0.25, 1])!)
                context.fill(CGRect(x: x, y: 68, width: 36, height: 72))
            }
        }
        return true
    }
}
