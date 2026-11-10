import Foundation

/// Caller-owned proof for a particular capture revision and source set.
/// The caller decides whether its effects, layout and interaction state are settled.
/// Engine validates geometry and capture lifetime without classifying components.
public struct NativeUICaptureReadiness {
    public let isSettled: Bool
    public init(isSettled: Bool = false) { self.isSettled = isSettled }
    var stableSamples: Int { isSettled ? 1 : 3 }
}
