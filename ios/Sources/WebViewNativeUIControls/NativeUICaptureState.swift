import UIKit
import WebViewNativeUIEngine

// Component IDs remain dirty until their own successful conservative capture.
// Capturing an unrelated component never acknowledges their interaction.
struct NativeUICaptureState {
    private(set) var dirty = Set<String>()
    mutating func interacted(_ ids: Set<String>) { dirty.formUnion(ids) }
    mutating func captured(_ ids: Set<String>) { dirty.subtract(ids) }
    mutating func retain(_ ids: Set<String>) { dirty.formIntersection(ids) }
    func appearanceSettled(_ ids: Set<String>) -> Bool { dirty.isDisjoint(with: ids) }
}
