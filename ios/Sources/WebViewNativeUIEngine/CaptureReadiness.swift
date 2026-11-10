import Foundation

/// Native renderer-owned readiness for a particular capture revision.
/// Unspecified or backdrop-dependent captures retain the standard geometry checks.
public struct NativeUICaptureReadiness {
    /// Whether pixels depend on backdrop composition (including Glass).
    public enum Effect: Equatable { case independent, backdrop, unknown }
    public let effect: Effect
    public let layoutSettled: Bool
    public let appearanceSettled: Bool
    public init(effect: Effect = .unknown, layoutSettled: Bool = false, appearanceSettled: Bool = false) {
        self.effect = effect; self.layoutSettled = layoutSettled; self.appearanceSettled = appearanceSettled
    }
    var stableSamples: Int { effect == .independent && layoutSettled && appearanceSettled ? 1 : 3 }
}
