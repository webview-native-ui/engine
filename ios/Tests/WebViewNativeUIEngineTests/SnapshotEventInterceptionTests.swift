import XCTest
import UIKit
@testable import WebViewNativeUIEngine

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
