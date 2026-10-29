import UIKit
import CoreImage
import ImageIO

/// Immutable, locally served images of controls that will be covered by a Web overlay.
/// Native interaction invalidates in-flight captures before Web receives the activation.
public final class NativeUICoveredSnapshots {
    private struct Part {
        let ids: [String]
        let frame: CGRect
        let image: UIImage
        let file: URL
    }
    private struct Capture {
        let size: CGSize
        let webFrame: CGRect
        let parts: [Part]
    }
    public init() {}
    private let imageContext = CIContext()
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
    public func handle(_ request: [String: Any], in webView: UIView,
                       frames: @escaping (Set<String>, Int) -> [String: CGRect],
                       views: (Set<String>) -> [UIView]?, complete: @escaping ([String: Any]) -> Void) {
        let token = request["token"] as? String ?? ""
        switch request["action"] as? String {
        case "prepare":
            guard let ids = request["ids"] as? [String], !ids.isEmpty, !ids.contains(""), Set(ids).count == ids.count,
                  let revision = request["revision"] as? Int,
                  let width = request["viewportWidth"] as? Double, width.isFinite, width > 0 else { complete([:]); return }
            let expected = Set(ids)
            let firstFrames = frames(expected, revision)
            guard Set(firstFrames.keys) == expected else { complete([:]); return }
            var initial: [String: CGRect]? = firstFrames
            prepare(frames: {
                let measured = initial ?? frames(expected, revision)
                initial = nil
                return Set(measured.keys) == expected ? measured : [:]
            }, in: webView, viewportWidth: width, complete: complete)
        case "cover":
            let ids = identifiers(for: token)
            let destination = request["parts"] == nil ? nil : projectionFrames(request, in: webView)
            guard !ids.isEmpty, let selected = views(ids), !selected.isEmpty,
                  request["parts"] == nil || destination != nil else { complete(["shown": false]); return }
            var seen = Set<ObjectIdentifier>()
            complete(["shown": cover(token, in: webView, views: selected.filter { seen.insert(ObjectIdentifier($0)).inserted },
                                     transient: request["transient"] as? Bool == true, frames: destination)])
        case "restore":
            guard let destination = projectionFrames(request, in: webView) else { complete(["shown": false]); return }
            complete(["shown": restore(in: webView, token: token, frames: destination)])
        case "painted", "restored":
            retireCopy(token, entry: request["action"] as? String == "painted")
            complete([:])
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

    public func observe(_ window: UIWindow, changed: @escaping (Bool) -> Void) {
        guard self.window !== window else { return }
        if let observer { self.window?.removeGestureRecognizer(observer) }
        self.window = window
        let observer = SnapshotTouchObserver { [weak self] active in
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
                        complete: @escaping ([String: Any]) -> Void) {
        let stamp = generation
        let start = CACurrentMediaTime()
        func sample(_ previous: [String: CGRect], _ stable: Int) {
            guard generation == stamp, !touching, CACurrentMediaTime() - start < 1 else { complete([:]); return }
            let current = frames()
            let count = !current.isEmpty && current == previous ? stable + 1 : 0
            if count >= 3 {
                capture(frames: current, in: webView, viewportWidth: viewportWidth, complete: complete)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { sample(current, count) }
            }
        }
        sample([:], 0)
    }

    private func capture(frames: [String: CGRect], in webView: UIView, viewportWidth: CGFloat,
                         complete: @escaping ([String: Any]) -> Void) {
        guard !touching, let window = webView.window, !frames.isEmpty,
              viewportWidth > 0, webView.bounds.width > 0 else { complete([:]); return }
        let stamp = generation
        let scale = window.screen.scale
        let ratio = viewportWidth / webView.bounds.width
        let size = window.bounds.size
        let webFrame = webView.convert(webView.bounds, to: window)
        // Each crop belongs to one source component. Overlapping crops share
        // the same captured pixels and never combine unrelated components.
        var regions: [(ids: [String], rect: CGRect)] = []
        for (id, frame) in frames.sorted(by: { $0.key < $1.key }) {
            var rect = webView.convert(frame, to: window).insetBy(dx: -12, dy: -12).intersection(window.bounds)
            guard !rect.isNull, rect.width > 0, rect.height > 0 else { complete([:]); return }
            rect = CGRect(x: floor(rect.minX * scale) / scale, y: floor(rect.minY * scale) / scale,
                          width: (ceil(rect.maxX * scale) - floor(rect.minX * scale)) / scale,
                          height: (ceil(rect.maxY * scale) - floor(rect.minY * scale)) / scale)
            regions.append(([id], rect))
        }
        let bounds = regions.reduce(CGRect.null) { $0.union($1.rect) }
        // Preserve wide-gamut precision during capture. Encode to integer 16-bit
        // Display P3 only off the presentation path, without a Canvas conversion.
        guard let space = CGColorSpace(name: CGColorSpace.extendedDisplayP3),
              let outputSpace = CGColorSpace(name: CGColorSpace.displayP3),
              let context = CGContext(data: nil, width: Int(bounds.width * scale), height: Int(bounds.height * scale),
                                      bitsPerComponent: 16, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder16Little.rawValue)
        else { complete([:]); return }
        context.translateBy(x: 0, y: bounds.height * scale)
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: -bounds.minX, y: -bounds.minY)
        // Capture the window itself: display-replica views can rasterize as black on devices.
        UIGraphicsPushContext(context)
        let drawn = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        UIGraphicsPopContext()
        guard drawn, let pixels = context.makeImage() else { complete([:]); return }
        let token = UUID().uuidString
        let directory = self.directory
        let crops = regions.compactMap { region -> (ids: [String], frame: CGRect, image: UIImage)? in
            let crop = CGRect(x: (region.rect.minX - bounds.minX) * scale, y: (region.rect.minY - bounds.minY) * scale,
                              width: region.rect.width * scale, height: region.rect.height * scale)
            guard let part = pixels.cropping(to: crop) else { return nil }
            return (region.ids, window.convert(region.rect, to: webView), UIImage(cgImage: part, scale: scale, orientation: .up))
        }
        guard crops.count == regions.count else { complete([:]); return }
        let imageContext = self.imageContext
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var parts: [Part] = []
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                for (index, crop) in crops.enumerated() {
                    guard let pixels = crop.image.cgImage,
                          let png = imageContext.pngRepresentation(of: CIImage(cgImage: pixels), format: .RGBA16,
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
                    parts.append(Part(ids: crop.ids, frame: crop.frame, image: image, file: file))
                }
            } catch {
                parts.forEach { try? FileManager.default.removeItem(at: $0.file) }
                parts = []
            }
            DispatchQueue.main.async {
                guard let self, self.generation == stamp, !self.touching,
                      window.bounds.size == size, webView.convert(webView.bounds, to: window) == webFrame, parts.count == crops.count else {
                    parts.forEach { try? FileManager.default.removeItem(at: $0.file) }
                    complete([:]); return
                }
                self.captures[token] = Capture(size: size, webFrame: webFrame, parts: parts)
                complete(["token": token, "parts": parts.map { part in
                    ["ids": part.ids, "url": part.file.absoluteString,
                     "x": part.frame.minX * ratio, "y": part.frame.minY * ratio,
                     "width": part.frame.width * ratio, "height": part.frame.height * ratio] as [String: Any]
                }])
            }
        }
    }

    /// Install prepared pixels before hiding live views, within the same main-thread turn.
    /// A transient (moving) surface does not replace background covering ownership.
    @discardableResult public func cover(_ token: String, in webView: UIView, views: [UIView], transient: Bool = false, frames: [String: CGRect]? = nil) -> Bool {
        guard restore(in: webView, token: token, frames: frames, entry: true) else { return false }
        if !transient { coveringToken = token }
        hide(views, for: token)
        return true
    }

    public var hidesNativeControls: Bool { hiddenControls != nil }

    private func hide(_ views: [UIView], for token: String) {
        generation += 1
        restoreControls()
        hiddenControls = (token, views.map { view in
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
            self?.clearRestoration()
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
        captures.removeValue(forKey: token)?.parts.forEach { try? FileManager.default.removeItem(at: $0.file) }
    }

    public func reset() {
        restoreControls()
        if let observer { window?.removeGestureRecognizer(observer) }
        observer = nil
        window = nil
        touching = false
        generation += 1
        coveringToken = nil
        Array(captures.keys).forEach(release)
    }

    deinit {
        if let observer { window?.removeGestureRecognizer(observer) }
        try? FileManager.default.removeItem(at: directory)
    }
}

// Observes the start of interaction without recognizing or delaying the app's gestures.
private final class SnapshotTouchObserver: UIGestureRecognizer {
    private let changed: (Bool) -> Void
    private var touches = Set<UITouch>()
    init(changed: @escaping (Bool) -> Void) {
        self.changed = changed
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }
    override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
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
