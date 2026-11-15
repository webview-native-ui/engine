import UIKit
import WebKit

/// A native scroll surface for renderer-owned views above a matched WebKit overflow.
/// Native SDK views retain normal hit testing; UIKit owns pan recognition and inertia.
/// Each host pairs this native surface with one Web overflow scroller. Offsets
/// are mirrored; inertia remains with the scroller that received the gesture.
/// New contact stops both scrollers before forwarding the original touch.
public final class NativeUIScrollHosting {
    private final class Surface: UIScrollView {
        var owners: [ObjectIdentifier: Owner] = [:]
        weak var source: UIScrollView?
        weak var webView: WKWebView?
        var scrollViews: [UIScrollView] {
            guard let source else { return [self] }
            return [self, source]
        }
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            // UIKit can hit-test before attaching the new UITouch to UIEvent.allTouches.
            let contacts = event?.allTouches ?? []
            if bounds.contains(point), event?.type == .touches,
               contacts.isEmpty || contacts.contains(where: { $0.phase == .began }) {
                for owner in owners.values {
                    guard let view = owner.view, let reveal = owner.reveal,
                          view.bounds.contains(view.convert(point, from: self)) else { continue }
                    for scroll in scrollViews where scroll.isDecelerating {
                        scroll.setContentOffset(scroll.contentOffset, animated: false)
                    }
                    reveal()
                }
            }
            guard let hit = super.hitTest(point, with: event), hit !== self else { return nil }
            // A denied reveal leaves the SDK hidden inside its renderer's clip.
            // That empty container must not intercept the Web overlay's input.
            guard NativeUIScrollHosting.owner(of: hit)?.reveal == nil else { return nil }
            return hit
        }

        override func touchesShouldCancel(in view: UIView) -> Bool { true }
    }

    private var webView: WKWebView? { surface.webView }
    private var scrollView: UIScrollView? { surface.source }
    private final class Owner {
        weak var view: UIView?
        weak var parent: UIView?
        var reveal: (() -> Void)?
        init(view: UIView, parent: UIView) { self.view = view; self.parent = parent }
    }
    private let surface = Surface()
    private var sourceObservation: NSKeyValueObservation?
    private var surfaceObservation: NSKeyValueObservation?
    private var synchronizing = false

    public init?(webView: WKWebView, scrollView: UIScrollView) {
        guard scrollView.isDescendant(of: webView), scrollView.window != nil, webView.superview != nil,
              abs(scrollView.zoomScale - 1) < 0.001 else { return nil }
        surface.source = scrollView
        surface.webView = webView
        surface.showsHorizontalScrollIndicator = false
        surface.showsVerticalScrollIndicator = false
        surface.contentInsetAdjustmentBehavior = .never
        surface.backgroundColor = .clear
        sourceObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            self?.synchronize(fromSurface: false)
        }
        surfaceObservation = surface.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            self?.synchronize(fromSurface: true)
        }
    }

    /// Reuse one host while a matched scroller owns a gesture or deceleration.
    public func matches(_ scrollView: UIScrollView, in webView: WKWebView) -> Bool {
        self.scrollView === scrollView && self.webView === webView && scrollView.isDescendant(of: webView)
    }

    /// `frame` is in WebView coordinates. The renderer owns clipping and removes
    /// its views on teardown. Empty overlay space remains available to the WebView.
    @discardableResult
    public func place(_ view: UIView, frame: CGRect) -> Bool {
        guard let webView, let scrollView, let parent = webView.superview,
              scrollView.isDescendant(of: webView), !scrollView.isHidden, let window = scrollView.window,
              abs(scrollView.zoomScale - 1) < 0.001,
              view !== surface, !surface.isDescendant(of: view), view !== scrollView,
              view !== webView, !webView.isDescendant(of: view),
              !frame.isNull, !frame.isInfinite,
              [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }),
              frame.width >= 0, frame.height >= 0 else { return false }
        guard NativeUISnapshotEventInterception.install(in: window) else { return false }
        let wasSynchronizing = synchronizing
        synchronizing = true
        defer { synchronizing = wasSynchronizing }
        if surface.superview !== parent { parent.addSubview(surface) }
        let viewport = scrollView.convert(scrollView.bounds, to: parent)
        if surface.frame != viewport { surface.frame = viewport }
        if surface.contentSize != scrollView.contentSize { surface.contentSize = scrollView.contentSize }
        if surface.contentInset != scrollView.contentInset { surface.contentInset = scrollView.contentInset }
        surface.bounces = scrollView.bounces
        surface.alwaysBounceVertical = scrollView.alwaysBounceVertical
        surface.alwaysBounceHorizontal = scrollView.alwaysBounceHorizontal
        surface.isDirectionalLockEnabled = scrollView.isDirectionalLockEnabled
        surface.decelerationRate = scrollView.decelerationRate
        if surface.isScrollEnabled != scrollView.isScrollEnabled { surface.isScrollEnabled = scrollView.isScrollEnabled }
        if surface.contentOffset != scrollView.contentOffset { surface.contentOffset = scrollView.contentOffset }
        if view.superview !== surface {
            let identifier = ObjectIdentifier(view)
            let previous = (view.superview as? Surface)?.owners.removeValue(forKey: identifier)
            surface.owners[identifier] = previous ?? Owner(view: view, parent: view.superview is Surface ? parent : view.superview ?? parent)
            surface.addSubview(view)
        }
        view.frame = surface.convert(frame, from: webView)
        surface.bringSubviewToFront(view)
        parent.bringSubviewToFront(surface)
        return true
    }

    private func synchronize(fromSurface: Bool) {
        guard !synchronizing, let webView, let scrollView, scrollView.isDescendant(of: webView) else { return }
        synchronizing = true
        defer { synchronizing = false }
        if fromSurface {
            if scrollView.contentOffset != surface.contentOffset { scrollView.contentOffset = surface.contentOffset }
        } else if surface.contentOffset != scrollView.contentOffset {
            surface.contentOffset = scrollView.contentOffset
        }
    }

    private static func owner(of view: UIView) -> Owner? {
        var current = view
        while let parent = current.superview {
            if let surface = parent as? Surface {
                guard let webView = surface.webView, let source = surface.source, source.isDescendant(of: webView) else { return nil }
                return surface.owners[ObjectIdentifier(current)]
            }
            current = parent
        }
        return nil
    }

    static func hosts(_ view: UIView) -> Bool { owner(of: view) != nil }

    static func revealOnContact(_ view: UIView, reveal: @escaping () -> Void) -> () -> Void {
        guard let owner = owner(of: view) else { return {} }
        owner.reveal = reveal
        return { [weak owner] in owner?.reveal = nil }
    }

    // These surfaces are WebView siblings so WebKit cannot intercept SDK input.
    // Include them explicitly in the Engine's existing motion and capture handling.
    static func hostedScrollViews(in webView: UIView) -> [UIScrollView] { surfaces(in: webView) }

    private static func surfaces(in webView: UIView) -> [Surface] {
        guard webView is WKWebView else { return [] }
        return webView.superview?.subviews.compactMap {
            guard let surface = $0 as? Surface, surface.webView === webView else { return nil }
            return surface
        } ?? []
    }

    static func isMoving(in webView: UIView, source: UIScrollView) -> Bool {
        surfaces(in: webView).contains {
            $0.source === source && ($0.isDragging || $0.isDecelerating)
        }
    }

    static func scrollViews(for touchedView: UIView) -> [UIScrollView] {
        var result: [Surface] = []
        var view: UIView? = touchedView
        while let current = view {
            if let surface = current as? Surface { result.append(surface) }
            if current is WKWebView {
                result += surfaces(in: current).filter {
                    guard let source = $0.source else { return false }
                    return touchedView.isDescendant(of: source)
                }
            }
            view = current.superview
        }
        return result.flatMap(\.scrollViews)
    }

    // Finish the touched scroll owner's native inertia before dispatching the
    // original event, whether contact starts on its SDK view or Web content.
    static func willSendEvent(_ event: UIEvent) {
        for touch in event.allTouches ?? [] where touch.phase == .began {
            guard let view = touch.view else { continue }
            for scroll in scrollViews(for: view) where scroll.isDecelerating {
                scroll.setContentOffset(scroll.contentOffset, animated: false)
            }
        }
    }

    deinit {
        // A placement tracker may be retired on pause or remapping while the SDK
        // view remains alive. Return those views to their renderer, preserving
        // visibility and current geometry; never retire another host's content.
        sourceObservation?.invalidate()
        surfaceObservation?.invalidate()
        surface.setContentOffset(surface.contentOffset, animated: false)
        for owner in surface.owners.values {
            guard let view = owner.view, let parent = owner.parent, view.superview === surface else { continue }
            let frame = view.convert(view.bounds, to: parent)
            parent.addSubview(view)
            view.frame = frame
        }
        surface.removeFromSuperview()
    }
}
