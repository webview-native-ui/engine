import UIKit

// Component effects belong to the renderer, not the capture engine.
enum NativeUICaptureEffect { case independent, backdrop, unknown }

// A capture ACK does not prove that UIKit's press animation finished.
// Track the actual source weakly, so reassociation keeps its interaction state
// while a genuinely new component starts clean without retaining old views.
final class NativeUICaptureState {
    private let dirty = NSHashTable<UIView>.weakObjects()
    func interacted(_ views: [UIView]) { views.forEach(dirty.add) }
    func appearanceSettled(_ views: [UIView]) -> Bool { views.allSatisfy { !dirty.contains($0) } }
}
