import UIKit
import ObjectiveC

/// Lazily wraps the concrete registered Window class; no new subclass or responder is installed.
/// Unregistered windows only forward. IMPs remain installed so another library's later wrapper
/// never ends up calling an IMP that Engine has freed or removed during teardown.
enum NativeUISnapshotEventInterception {
    private typealias SendEvent = @convention(c) (UIWindow, Selector, UIEvent) -> Void
    private static var installed = Set<ObjectIdentifier>()
    private static var dispatching = Set<ObjectIdentifier>()
    private static var announced = Set<ObjectIdentifier>()

    static func install(in window: UIWindow) -> Bool {
        precondition(Thread.isMainThread)
        guard let type = object_getClass(window) else { return false }
        let identity = ObjectIdentifier(type)
        if installed.contains(identity) { return true }
        let selector = #selector(UIWindow.sendEvent(_:))
        guard let method = class_getInstanceMethod(type, selector), let encoding = method_getTypeEncoding(method) else { return false }
        let original = unsafeBitCast(method_getImplementation(method), to: SendEvent.self)
        let block: @convention(block) (UIWindow, UIEvent) -> Void = { window, event in
            let identity = ObjectIdentifier(window)
            guard dispatching.insert(identity).inserted else {
                original(window, selector, event)
                return
            }
            defer { announced.remove(identity); dispatching.remove(identity) }
            if NativeUICoveredSnapshots.automaticallyInterceptsEvents {
                NativeUICoveredSnapshots.willSendEvent(event, in: window)
            }
            original(window, selector, event)
        }
        let replacement = imp_implementationWithBlock(block)
        // An inherited method must become an override here; replacing its Method directly
        // would instead mutate the superclass and miss a subclass's work before super.
        if !class_addMethod(type, selector, replacement, encoding) {
            method_setImplementation(method, replacement)
        }
        installed.insert(identity)
        return true
    }

    /// Also covers an existing explicit NativeUISnapshotWindow forwarding the same dispatch.
    static func shouldAnnounce(in window: UIWindow) -> Bool {
        let identity = ObjectIdentifier(window)
        return !dispatching.contains(identity) || announced.insert(identity).inserted
    }
}
