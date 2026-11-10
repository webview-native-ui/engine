import UIKit
import CoreImage
import ImageIO

/// Immutable, locally served images of controls that will be covered by a Web overlay.
/// Native interaction invalidates in-flight captures before Web receives the activation.
public final class NativeUICoveredSnapshots {
    private struct Part {
        let ids: [String]
        let frame: CGRect
        let anchorFrame: CGRect
        let image: UIImage
        let file: URL
    }
    private struct Capture {
        let size: CGSize
        let webFrame: CGRect
        let parts: [Part]
        var preservesLayout = false
    }
    private final class CachedView {
        weak var view: UIView?
        let bounds: CGRect
        let transform: CGAffineTransform
        let alpha: CGFloat
        let traits: UITraitCollection
        init(_ view: UIView) {
            self.view = view
            bounds = view.bounds
            transform = view.transform
            alpha = view.alpha
            traits = view.traitCollection
        }
        func matches(_ current: UIView) -> Bool {
            let value = current.transform
            return view === current && bounds == current.bounds &&
                transform.a == value.a && transform.b == value.b && transform.c == value.c && transform.d == value.d &&
                alpha == current.alpha && traits.isEqual(current.traitCollection) && !current.isHidden
        }
    }
    private struct ViewCache {
        let revision: Int
        weak var window: UIWindow?
        let scale: CGFloat
        let views: [CachedView]
        let geometry: [CGRect]
        let parts: [Part]
    }
    private var viewCache: ViewCache?
    private final class PixelVisibility {
        let originalMask: CALayer?
        let interaction: Bool
        let accessibility: Bool
        let concealedMask = CALayer()
        var owners = 0
        init(_ view: UIView) {
            originalMask = view.layer.mask
            interaction = view.isUserInteractionEnabled
            accessibility = view.accessibilityElementsHidden
        }
    }
    private static let pixelVisibility = NSMapTable<UIView, PixelVisibility>(keyOptions: .weakMemory, valueOptions: .strongMemory)
    public init() {}
    private let imageContext = CIContext()
    private let pngEncoder = NativeUIPngEncoder()
    private var captures: [String: Capture] = [:]
    private var restoration: (token: String, views: [UIImageView], entry: Bool)?
    private var hiddenControls: (token: String, restore: [() -> Void])?
    private var generation = 0
    private var touching = false
    private weak var window: UIWindow?
    private var observer: SnapshotTouchObserver?
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-ui-snapshots-\(UUID().uuidString)")
    public private(set) var coveringToken: String?
    /// Dispatch the renderer's existing ordered image-handoff transport on the main thread.
    /// The renderer supplies eligible native bounds and the complete views that may be hidden.
    /// A nil view selection rejects the handoff; an empty selection means the valid image has no live views to retire.
    public func handle(_ request: [String: Any], in webView: UIView,
                       frames: @escaping (Set<String>, Int) -> [String: CGRect],
                       anchorFrames: (() -> [String: CGRect])? = nil,
                       views: (Set<String>) -> [UIView]?,
                       readiness: ((Set<String>, Int) -> NativeUICaptureReadiness)? = nil, complete: @escaping ([String: Any]) -> Void) {
        let token = request["token"] as? String ?? ""
        switch request["action"] as? String {
        case "prepare":
            guard let ids = request["ids"] as? [String], !ids.isEmpty, !ids.contains(""), Set(ids).count == ids.count,
                  let revision = request["revision"] as? Int,
                  let width = request["viewportWidth"] as? Double, width.isFinite, width > 0 else { complete([:]); return }
            let expected = Set(ids)
            let firstFrames = frames(expected, revision)
            guard Set(firstFrames.keys) == expected else { complete([:]); return }
            let viewCapture = request["captureMode"] as? String == "view"
            let selected = viewCapture ? views(expected) : nil
            guard !viewCapture || selected?.isEmpty == false else { complete([:]); return }
            var initial: [String: CGRect]? = firstFrames
            prepareCapture(frames: {
                let measured = initial ?? frames(expected, revision)
                initial = nil
                return Set(measured.keys) == expected ? measured : [:]
            }, in: webView, viewportWidth: width, views: selected, anchorFrames: anchorFrames, contentRevision: viewCapture ? revision : nil,
                           readiness: viewCapture ? readiness.map { provider in { provider(expected, revision) } } : nil, complete: { result in
                if let token = result["token"] as? String { self.captures[token]?.preservesLayout = request["imageSurface"] as? String == "web" }
                complete(result)
            })
        case "cover":
            let ids = identifiers(for: token)
            let destination = request["parts"] == nil ? nil : projectionFrames(request, in: webView)
            guard !ids.isEmpty, let selected = views(ids),
                  request["parts"] == nil || destination != nil else { complete(["shown": false]); return }
            var seen = Set<ObjectIdentifier>()
            complete(["shown": cover(token, in: webView, views: selected.filter { seen.insert(ObjectIdentifier($0)).inserted },
                                     transient: request["transient"] as? Bool == true, frames: destination)])
        case "restore":
            guard let destination = projectionFrames(request, in: webView) else { complete(["shown": false]); return }
            complete(["shown": restore(in: webView, token: token, frames: destination)])
        case "painted", "restored":
            retireCopy(token, entry: request["action"] as? String == "painted")
            complete(request["action"] as? String == "painted" ? ["shown": captures[token] != nil] : [:])
        case "release": release(token); complete([:])
        case "reset": reset(); complete([:])
        default: complete([:])
        }
    }

    /// Convert Web viewport CSS pixels to native points, rejecting partial or malformed destinations.
    func projectionFrames(_ request: [String: Any], in webView: UIView) -> [String: CGRect]? {
        guard let token = request["token"] as? String,
              let width = request["viewportWidth"] as? Double, width.isFinite, width > 0,
              webView.bounds.width > 0, let parts = request["parts"] as? [[String: Any]], !parts.isEmpty else { return nil }
        let scale = webView.bounds.width / width
        var result: [String: CGRect] = [:]
        for part in parts {
            guard let ids = part["ids"] as? [String], !ids.isEmpty,
                  let x = part["x"] as? Double, let y = part["y"] as? Double,
                  let w = part["width"] as? Double, let h = part["height"] as? Double,
                  [x, y, w, h, x * scale, y * scale, w * scale, h * scale].allSatisfy({ $0.isFinite }), w > 0, h > 0 else { return nil }
            for id in ids {
                guard !id.isEmpty, result[id] == nil else { return nil }
                result[id] = CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale)
            }
        }
        return !result.isEmpty && Set(result.keys) == identifiers(for: token) ? result : nil
    }

    public var covering: Bool { coveringToken != nil }

    public func observe(_ window: UIWindow, interacted: ((UIView?) -> Void)? = nil, changed: @escaping (Bool) -> Void) {
        guard self.window !== window else { return }
        if let observer { self.window?.removeGestureRecognizer(observer) }
        self.window = window
        let observer = SnapshotTouchObserver(interacted: interacted) { [weak self] active in
            guard let self else { return }
            self.touching = active
            if active { self.generation += 1 }
            changed(active)
        }
        window.addGestureRecognizer(observer)
        self.observer = observer
    }

    // Gesture release can keep changing SwiftUI button bounds after touchesEnded.
    // Wait off the presentation path for unchanged rendered geometry, not a guessed delay.
    public func prepare(frames: @escaping () -> [String: CGRect], in webView: UIView, viewportWidth: CGFloat,
                        views: [UIView]? = nil, anchorFrames: (() -> [String: CGRect])? = nil, readiness: (() -> NativeUICaptureReadiness)? = nil,
                        complete: @escaping ([String: Any]) -> Void) {
        prepareCapture(frames: frames, in: webView, viewportWidth: viewportWidth, views: views,
                       anchorFrames: anchorFrames, contentRevision: nil, readiness: readiness, complete: complete)
    }

    private func prepareCapture(frames: @escaping () -> [String: CGRect], in webView: UIView, viewportWidth: CGFloat,
                                views: [UIView]?, anchorFrames: (() -> [String: CGRect])?, contentRevision: Int?,
                                readiness: (() -> NativeUICaptureReadiness)? = nil, complete: @escaping ([String: Any]) -> Void) {
        let stamp = generation
        let start = CACurrentMediaTime()
        var requiredSamples = 1
        func sample(_ previous: [String: CGRect], _ stable: Int) {
            guard generation == stamp, !touching, CACurrentMediaTime() - start < 1 else { complete([:]); return }
            let current = frames()
            let count = !current.isEmpty && current == previous ? stable + 1 : 0
            // Recheck the renderer's proof on every sample; a revoked proof falls back.
            let currentRequirement = views?.isEmpty == false ? (readiness?().stableSamples ?? 3) : 3
            requiredSamples = max(requiredSamples, currentRequirement)
            if count >= requiredSamples {
                capture(frames: current, anchorFrames: anchorFrames?() ?? [:], in: webView, viewportWidth: viewportWidth, views: views, contentRevision: contentRevision,
                        stillReady: requiredSamples == 1 ? { readiness?().stableSamples == 1 && frames() == current } : nil,
                        complete: complete)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { sample(current, count) }
            }
        }
        sample([:], 0)
    }

    private func capture(frames: [String: CGRect], anchorFrames: [String: CGRect], in webView: UIView, viewportWidth: CGFloat,
                         views: [UIView]?, contentRevision: Int?, stillReady: (() -> Bool)? = nil, complete: @escaping ([String: Any]) -> Void) {
        guard !touching, let window = webView.window, !frames.isEmpty,
              viewportWidth > 0, webView.bounds.width > 0 else { complete([:]); return }
        let stamp = generation
        let scale = window.screen.scale
        let ratio = viewportWidth / webView.bounds.width
        let size = window.bounds.size
        let webFrame = webView.convert(webView.bounds, to: window)
        // Each crop belongs to one source component. Overlapping crops share
        // the same captured pixels and never combine unrelated components.
        var regions: [(ids: [String], rect: CGRect, anchorFrame: CGRect)] = []
        for (id, frame) in frames.sorted(by: { $0.key < $1.key }) {
            var rect = webView.convert(frame, to: window).insetBy(dx: -12, dy: -12).intersection(window.bounds)
            guard !rect.isNull, rect.width > 0, rect.height > 0 else { complete([:]); return }
            rect = CGRect(x: floor(rect.minX * scale) / scale, y: floor(rect.minY * scale) / scale,
                          width: (ceil(rect.maxX * scale) - floor(rect.minX * scale)) / scale,
                          height: (ceil(rect.maxY * scale) - floor(rect.minY * scale)) / scale)
            let anchor = anchorFrames[id] ?? frame
            guard [anchor.minX, anchor.minY, anchor.width, anchor.height].allSatisfy(\.isFinite), anchor.width > 0, anchor.height > 0 else {
                complete([:]); return
            }
            regions.append(([id], rect, anchor))
        }
        // All roots are drawn into one context: a crop can contain another root.
        // Reuse requires one common translation of every source and crop rectangle.
        let geometry = (views ?? []).map { $0.convert($0.bounds, to: window) } + regions.map(\.rect)
        func sameArrangement(_ previous: [CGRect]) -> Bool {
            guard previous.count == geometry.count, let first = previous.first, let current = geometry.first else { return false }
            let offsetX = current.minX - first.minX
            let offsetY = current.minY - first.minY
            return zip(previous, geometry).allSatisfy { old, current in old.offsetBy(dx: offsetX, dy: offsetY) == current }
        }
        // Reuse only explicit view content, never composited window/backdrop pixels.
        // Layout-only moves rebase the existing immutable PNG and decoded UIImage.
        if let views, let revision = contentRevision, let cached = viewCache,
           cached.revision == revision, cached.window === window, cached.scale == scale,
           sameArrangement(cached.geometry),
           views.allSatisfy({ $0.window === window && !$0.isHidden && $0.alpha > 0 }),
           cached.views.count == views.count, zip(cached.views, views).allSatisfy({ $0.0.matches($0.1) }),
           cached.parts.count == regions.count,
           zip(cached.parts, regions).allSatisfy({ part, region in
            let frame = window.convert(region.rect, to: webView)
            return part.ids == region.ids && part.frame.size == frame.size &&
                part.anchorFrame.size == region.anchorFrame.size &&
                part.anchorFrame.minX - part.frame.minX == region.anchorFrame.minX - frame.minX &&
                part.anchorFrame.minY - part.frame.minY == region.anchorFrame.minY - frame.minY &&
                FileManager.default.fileExists(atPath: part.file.path)
           }) {
            let parts = zip(cached.parts, regions).map { part, region in
                Part(ids: part.ids, frame: window.convert(region.rect, to: webView), anchorFrame: region.anchorFrame,
                     image: part.image, file: part.file)
            }
            deliver(parts, size: size, webFrame: webFrame, ratio: ratio, reused: true, complete: complete)
            return
        }
        let capturedViews = views?.map(CachedView.init)
        let bounds = regions.reduce(CGRect.null) { $0.union($1.rect) }
        // Preserve wide-gamut precision during capture. Encode to integer 16-bit
        // Display P3 only off the presentation path, without a Canvas conversion.
        guard let space = CGColorSpace(name: CGColorSpace.extendedDisplayP3),
              let outputSpace = CGColorSpace(name: CGColorSpace.displayP3),
              let context = CGContext(data: nil, width: Int(bounds.width * scale), height: Int(bounds.height * scale),
                                      bitsPerComponent: 16, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
                                        CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder16Little.rawValue)
        else { complete([:]); return }
        context.translateBy(x: 0, y: bounds.height * scale)
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: -bounds.minX, y: -bounds.minY)
        // View capture preserves transparent pixels outside the renderer's own material.
        // The default window capture retains composited backdrop effects.
        var roots: [UIView]?
        if let views {
            guard !views.isEmpty, views.allSatisfy({ $0.window === window && !$0.isHidden && $0.alpha > 0 }) else { complete([:]); return }
            var seen = Set<ObjectIdentifier>()
            roots = views.filter { view in
                seen.insert(ObjectIdentifier(view)).inserted && !views.contains { $0 !== view && view.isDescendant(of: $0) }
            }
        }
        UIGraphicsPushContext(context)
        var drawn = true
        if let roots {
            for root in roots {
                drawn = root.drawHierarchy(in: root.convert(root.bounds, to: window), afterScreenUpdates: true) && drawn
            }
        } else {
            drawn = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        UIGraphicsPopContext()
        guard drawn, let pixels = context.makeImage() else { complete([:]); return }
        let token = UUID().uuidString
        let directory = self.directory
        let crops = regions.compactMap { region -> (ids: [String], frame: CGRect, anchorFrame: CGRect, image: UIImage)? in
            let crop = CGRect(x: (region.rect.minX - bounds.minX) * scale, y: (region.rect.minY - bounds.minY) * scale,
                              width: region.rect.width * scale, height: region.rect.height * scale)
            guard let part = pixels.cropping(to: crop) else { return nil }
            return (region.ids, window.convert(region.rect, to: webView), region.anchorFrame, UIImage(cgImage: part, scale: scale, orientation: .up))
        }
        guard crops.count == regions.count else { complete([:]); return }
        let imageContext = self.imageContext
        let pngEncoder = self.pngEncoder
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var parts: [Part] = []
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let workerLimit = 2
                let smallCrops = crops.allSatisfy { ($0.image.cgImage?.width ?? 0) * ($0.image.cgImage?.height ?? 0) <= 500_000 }
                let workerCount = smallCrops ? min(workerLimit, crops.count) : 1
                let lock = NSLock()
                var results = [Part?](repeating: nil, count: crops.count)
                DispatchQueue.concurrentPerform(iterations: workerCount) { worker in
                    for index in stride(from: worker, to: crops.count, by: workerCount) {
                        autoreleasepool {
                            let crop = crops[index]
                            do {
                                guard let pixels = crop.image.cgImage,
                                      let png = pngEncoder.encode(CIImage(cgImage: pixels), colorSpace: outputSpace) ??
                                        imageContext.pngRepresentation(of: CIImage(cgImage: pixels), format: .RGBA16,
                                                                       colorSpace: outputSpace, options: [:]) else { throw CocoaError(.fileWriteUnknown) }
                                // Native entry/return copies must use the same encoded pixels as Web,
                                // including gamut clipping performed by integer PNG conversion.
                                guard let source = CGImageSourceCreateWithData(png as CFData, nil),
                                      let decoded = CGImageSourceCreateImageAtIndex(source, 0,
                                                                                    [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
                                else { throw CocoaError(.fileWriteUnknown) }
                                let image = UIImage(cgImage: decoded, scale: scale, orientation: .up)
                                let file = directory.appendingPathComponent("\(token)-\(index).png")
                                try png.write(to: file, options: .atomic)
                                let part = Part(ids: crop.ids, frame: crop.frame, anchorFrame: crop.anchorFrame, image: image, file: file)
                                lock.lock()
                                results[index] = part
                                lock.unlock()
                            } catch { /* A missing result rejects the entire capture below. */ }
                        }
                    }
                }
                parts = results.compactMap { $0 }
                guard parts.count == crops.count else { throw CocoaError(.fileWriteUnknown) }
            } catch {
                parts.forEach { try? FileManager.default.removeItem(at: $0.file) }
                parts = []
            }
            DispatchQueue.main.async {
                guard let self, self.generation == stamp, !self.touching, stillReady?() != false,
                      stillReady == nil || zip(capturedViews ?? [], views ?? []).allSatisfy({ $0.0.matches($0.1) }),
                      window.bounds.size == size, webView.convert(webView.bounds, to: window) == webFrame, parts.count == crops.count else {
                    parts.forEach { try? FileManager.default.removeItem(at: $0.file) }
                    complete([:]); return
                }
                if views != nil, let revision = contentRevision,
                   parts.reduce(0, { $0 + ($1.image.cgImage?.width ?? 0) * ($1.image.cgImage?.height ?? 0) }) <= 8_000_000 {
                    let previous = self.viewCache
                    self.viewCache = ViewCache(revision: revision, window: window, scale: scale,
                                               views: capturedViews ?? [], geometry: geometry, parts: parts)
                    previous?.parts.forEach(self.removeIfUnused)
                }
                self.deliver(parts, size: size, webFrame: webFrame, ratio: ratio, complete: complete)
            }
        }
    }

    private func deliver(_ parts: [Part], size: CGSize, webFrame: CGRect, ratio: CGFloat, reused: Bool = false,
                         complete: ([String: Any]) -> Void) {
        let token = UUID().uuidString
        captures[token] = Capture(size: size, webFrame: webFrame, parts: parts)
        complete(["token": token, "reused": reused, "parts": parts.map { part in
            ["ids": part.ids, "url": part.file.absoluteString,
             "x": part.frame.minX * ratio, "y": part.frame.minY * ratio,
             "width": part.frame.width * ratio, "height": part.frame.height * ratio,
             "anchorBounds": ["x": (part.anchorFrame.minX - part.frame.minX) * ratio,
                              "y": (part.anchorFrame.minY - part.frame.minY) * ratio,
                              "width": part.anchorFrame.width * ratio, "height": part.anchorFrame.height * ratio]] as [String: Any]
        }])
    }

    private func removeIfUnused(_ part: Part) {
        guard viewCache?.parts.contains(where: { $0.file == part.file }) != true,
              !captures.values.contains(where: { $0.parts.contains(where: { $0.file == part.file }) }) else { return }
        try? FileManager.default.removeItem(at: part.file)
    }

    /// Install prepared pixels before hiding live views, within the same main-thread turn.
    /// A transient (moving) surface does not replace background covering ownership.
    @discardableResult public func cover(_ token: String, in webView: UIView, views: [UIView], transient: Bool = false, frames: [String: CGRect]? = nil) -> Bool {
        if !restore(in: webView, token: token, frames: frames, entry: true) { return false }
        if !transient { coveringToken = token }
        hide(views, for: token)
        return true
    }

    public var hidesNativeControls: Bool { hiddenControls != nil }

    /// Conceal only presentation pixels; keep layout and hosted renderer lifetimes intact.
    /// The owner restores this lease before applying its next presentation policy.
    public static func concealPixels(in view: UIView) -> () -> Void {
        let state = pixelVisibility.object(forKey: view) ?? PixelVisibility(view)
        pixelVisibility.setObject(state, forKey: view)
        state.owners += 1
        view.layer.mask = state.concealedMask
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        var restored = false
        return { [weak view] in
            guard !restored else { return }
            restored = true
            state.owners -= 1
            guard state.owners == 0, let view else { return }
            view.layer.mask = state.originalMask
            view.isUserInteractionEnabled = state.interaction
            view.accessibilityElementsHidden = state.accessibility
            pixelVisibility.removeObject(forKey: view)
        }
    }

    private func hide(_ views: [UIView], for token: String) {
        generation += 1
        restoreControls()
        hiddenControls = (token, views.map { view in
            if captures[token]?.preservesLayout == true { return Self.concealPixels(in: view) }
            let hidden = view.isHidden
            view.isHidden = true
            return { [weak view] in view?.isHidden = hidden }
        })
    }

    // Undo only the entry handoff's mutation; normal update owns subsequent visibility.
    public func restoreControls() {
        hiddenControls?.restore.forEach { $0() }
        hiddenControls = nil
    }

    public func identifiers(for token: String) -> Set<String> { Set(captures[token]?.parts.flatMap { $0.ids } ?? []) }

    // Bridge the entry or return with the already prepared pixels until Web retires the copy.
    // No capture, encoding, or decoding runs here.
    public func restore(in webView: UIView, token explicitToken: String? = nil, frames: [String: CGRect]? = nil, entry: Bool = false) -> Bool {
        guard let token = explicitToken ?? coveringToken, let capture = captures[token], let window = webView.window,
              window.bounds.size == capture.size, webView.convert(webView.bounds, to: window) == capture.webFrame else { return false }
        if let frames, capture.parts.contains(where: { part in !part.ids.allSatisfy { frames[$0] != nil } }) { return false }
        clearRestoration()
        let views = capture.parts.map { part in
            let view = UIImageView(image: part.image)
            view.frame = webView.convert(frames?[part.ids[0]] ?? part.frame, to: window)
            view.isUserInteractionEnabled = false
            view.isAccessibilityElement = false
            window.addSubview(view)
            return view
        }
        restoration = (token, views, entry)
        // A lost cleanup message must never leave an obsolete cover on live UI.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard self?.restoration?.views.first === views.first else { return }
            if entry { self?.release(token) } else { self?.clearRestoration() }
        }
        return true
    }

    public func retireCopy(_ token: String, entry: Bool = true) {
        // A late entry acknowledgement cannot remove the copy used on return.
        guard restoration?.entry == entry, restoration?.token == token else { return }
        clearRestoration()
    }

    private func clearRestoration() {
        restoration?.views.forEach { $0.removeFromSuperview() }
        restoration = nil
    }

    public func finishCovering() { coveringToken = nil }

    public func release(_ token: String) {
        if hiddenControls?.token == token { restoreControls() }
        if coveringToken == token { coveringToken = nil }
        if restoration?.token == token { clearRestoration() }
        captures.removeValue(forKey: token)?.parts.forEach(removeIfUnused)
    }

    public func reset() {
        restoreControls()
        if let observer { window?.removeGestureRecognizer(observer) }
        observer = nil
        window = nil
        touching = false
        generation += 1
        coveringToken = nil
        let previous = viewCache
        viewCache = nil
        Array(captures.keys).forEach(release)
        previous?.parts.forEach(removeIfUnused)
    }

    deinit {
        if let observer { window?.removeGestureRecognizer(observer) }
        try? FileManager.default.removeItem(at: directory)
    }
}

// Observes the start of interaction without recognizing or delaying the app's gestures.
final class SnapshotTouchObserver: UIGestureRecognizer {
    private let changed: (Bool) -> Void
    private let interacted: ((UIView?) -> Void)?
    private var touches = Set<UITouch>()
    init(interacted: ((UIView?) -> Void)?, changed: @escaping (Bool) -> Void) {
        self.interacted = interacted
        self.changed = changed
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }
    override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        touches.forEach { interacted?($0.view) }
        let first = self.touches.isEmpty
        self.touches.formUnion(touches)
        if first { changed(true) }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { finish(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { finish(touches) }
    private func finish(_ touches: Set<UITouch>) {
        self.touches.subtract(touches)
        if self.touches.isEmpty { changed(false); state = .failed }
    }
}
