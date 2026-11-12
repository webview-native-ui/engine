import XCTest
import UIKit
@testable import WebViewNativeUIEngine

final class NativeUICapturePlannerTests: XCTestCase {
    func testScaleAndAreaCanSelectOneTwoOrThreePasses() {
        let model = NativeUICaptureCostModel(drawMilliseconds: 10, megapixelMilliseconds: 10)
        let two = [CGRect(x: 0, y: 68, width: 466, height: 68), CGRect(x: 0, y: 583, width: 466, height: 95)]
        XCTAssertEqual(NativeUICapturePlanner.plan(two, scale: 1, model: model).count, 1)
        XCTAssertEqual(NativeUICapturePlanner.plan(two, scale: 3, model: model).count, 2)
        let three = [60.0, 325, 600].map { CGRect(x: 0, y: $0, width: 466, height: 44) }
        XCTAssertEqual(NativeUICapturePlanner.plan(three, scale: 4, model: model).count, 3)
        XCTAssertEqual(NativeUICapturePlanner.plan(three, scale: 4, drawsPerPass: 12, model: model).count, 1)
    }

    func testMergesNearbyBandsInsteadOfSplittingEveryComponent() {
        let regions = [60.0, 120, 600].map { CGRect(x: 0, y: $0, width: 466, height: 44) }
        let plan = NativeUICapturePlanner.plan(regions, scale: 3,
                                             model: .init(drawMilliseconds: 10, megapixelMilliseconds: 10))
        XCTAssertEqual(plan, [regions[0].union(regions[1]), regions[2]])
        XCTAssertTrue(regions.allSatisfy { source in plan.filter { $0.contains(source) }.count == 1 })
    }

    func testKeepsNarrowRegionsNarrowAndVerticalOverlapTogether() {
        let narrow = [CGRect(x: 100, y: 60, width: 80, height: 44), CGRect(x: 100, y: 600, width: 80, height: 44)]
        XCTAssertEqual(NativeUICapturePlanner.plan(narrow, scale: 3).count, 1)
        let wide = [CGRect(x: 0, y: 60, width: 466, height: 44), CGRect(x: 0, y: 600, width: 466, height: 44)]
        let vertical = CGRect(x: 10, y: 60, width: 60, height: 584)
        XCTAssertEqual(NativeUICapturePlanner.plan(wide + [vertical], scale: 3), [wide[0].union(wide[1])])
        XCTAssertEqual(NativeUICapturePlanner.plan([], scale: 3), [])
    }

    func testDynamicPlanMatchesExhaustivePartitionCosts() {
        let bands = [CGFloat(20), 90, 170, 360, 440, 610].enumerated().map { index, y in
            CGRect(x: index % 2 == 0 ? 0 : 30, y: y, width: index % 2 == 0 ? 420 : 380, height: 30)
        }
        let model = NativeUICaptureCostModel(drawMilliseconds: 8, megapixelMilliseconds: 12)
        for scale: CGFloat in [1, 2, 3, 4] {
            var minimum = Double.infinity
            for mask in 0..<32 {
                var groups = [bands[0]]
                for index in 1..<bands.count {
                    if mask & (1 << (index - 1)) != 0 { groups.append(bands[index]) } else { groups[groups.count - 1] = groups[groups.count - 1].union(bands[index]) }
                }
                minimum = min(minimum, groups.reduce(0) { $0 + model.cost($1, scale: scale, drawsPerPass: 1) })
            }
            let selected = NativeUICapturePlanner.plan(bands, scale: scale, model: model)
            XCTAssertEqual(selected.reduce(0) { $0 + model.cost($1, scale: scale, drawsPerPass: 1) }, minimum, accuracy: 0.000_001)
        }
    }
}

final class NativeUISnapshotEventInterceptionTests: XCTestCase {
    @MainActor func testConcreteSubclassInterceptionPreservesOriginalAndInheritedForwarding() {
        let owner = NativeUICoveredSnapshots()
        let window = ChildForwardingWindow(frame: .zero)
        let unrelated = ForwardingWindow(frame: .zero)
        var capability = false
        owner.observeInteractions(window) { capability = capability || $0["capturePolicy"] as? String == "preinteraction" }
        XCTAssertTrue(capability, "Ordinary UIWindow subclasses need no integration hook")
        let event = UIEvent()
        window.sendEvent(event)
        unrelated.sendEvent(event)
        XCTAssertEqual(window.forwarded, 1)
        XCTAssertEqual(unrelated.forwarded, 1)
        XCTAssertTrue(window.lastEvent === event)
        owner.observeInteractions(window) { _ in }
        window.sendEvent(event)
        XCTAssertEqual(window.forwarded, 2, "Repeated registration must not duplicate original delivery")
        owner.reset()
        window.sendEvent(event)
        XCTAssertEqual(window.forwarded, 3, "Teardown must preserve normal dispatch")
    }

    @MainActor func testSubclassCallingInterceptedSuperForwardsExactlyOnce() {
        let parent = ForwardingWindow(frame: .zero)
        let child = ComposedForwardingWindow(frame: .zero)
        let parentOwner = NativeUICoveredSnapshots(), childOwner = NativeUICoveredSnapshots()
        parentOwner.observeInteractions(parent) { _ in }
        childOwner.observeInteractions(child) { _ in }
        let event = UIEvent()
        child.sendEvent(event)
        XCTAssertEqual(child.forwarded, 1)
        XCTAssertEqual(child.localCalls, 1)
        XCTAssertEqual(parent.forwarded, 0)
        childOwner.reset(); parentOwner.reset()
        child.sendEvent(event)
        XCTAssertEqual(child.forwarded, 2)
        XCTAssertEqual(child.localCalls, 2)
    }

    @MainActor func testAutomaticInterceptionCanBeDisabledBeforeRegistration() {
        NativeUICoveredSnapshots.automaticallyInterceptsEvents = false
        defer { NativeUICoveredSnapshots.automaticallyInterceptsEvents = true }
        let owner = NativeUICoveredSnapshots()
        let window = UIWindow(frame: .zero)
        var capability = false
        owner.observeInteractions(window) { capability = capability || $0["capturePolicy"] as? String == "preinteraction" }
        XCTAssertFalse(capability)
        owner.reset()
    }
}

private class ForwardingWindow: UIWindow {
    var forwarded = 0
    weak var lastEvent: UIEvent?
    override func sendEvent(_ event: UIEvent) { forwarded += 1; lastEvent = event }
}
private final class ChildForwardingWindow: ForwardingWindow {}

private final class ComposedForwardingWindow: ForwardingWindow {
    var localCalls = 0
    override func sendEvent(_ event: UIEvent) {
        localCalls += 1
        super.sendEvent(event)
    }
}
