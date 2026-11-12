import UIKit

/// Acquisition cost, excluding conversion/encoding, for one hierarchy draw and one million Float16 pixels.
/// Calibrate on representative devices; a pass draws every explicit root in its original order.
struct NativeUICaptureCostModel {
    let drawMilliseconds: Double
    let megapixelMilliseconds: Double
    let rowMegapixelMilliseconds: Double

    init(drawMilliseconds: Double, megapixelMilliseconds: Double, rowMegapixelMilliseconds: Double = 0) {
        precondition(drawMilliseconds.isFinite && drawMilliseconds > 0)
        precondition(megapixelMilliseconds.isFinite && megapixelMilliseconds > 0)
        precondition(rowMegapixelMilliseconds.isFinite && rowMegapixelMilliseconds >= 0)
        self.rowMegapixelMilliseconds = rowMegapixelMilliseconds
        self.drawMilliseconds = drawMilliseconds
        self.megapixelMilliseconds = megapixelMilliseconds
    }

    // Rounded positive fit of the Device Hub matrix. The row-area term is an empirical
    // proxy for window rendering work, not a claim about UIKit's internal implementation.
    static let `default` = NativeUICaptureCostModel(drawMilliseconds: 7, megapixelMilliseconds: 2.5, rowMegapixelMilliseconds: 5)
    static let viewDefault = NativeUICaptureCostModel(drawMilliseconds: 7, megapixelMilliseconds: 2.5)

    func cost(_ rect: CGRect, scale: CGFloat, drawsPerPass: Int, windowWidth: CGFloat? = nil, nativeScale: CGFloat? = nil) -> Double {
        let displayScale = nativeScale ?? scale
        let rows = Double((windowWidth ?? rect.width) * rect.height * displayScale * displayScale) / 1_000_000
        let output = Double(rect.width * rect.height * scale * scale) / 1_000_000
        return Double(drawsPerPass) * drawMilliseconds + rows * rowMegapixelMilliseconds + output * megapixelMilliseconds
    }
}

enum NativeUICapturePlanner {
    /// Overlapping vertical intervals must share pixels. Keep their bounding rectangles tight in X.
    static func bands(_ regions: [CGRect]) -> [CGRect] {
        var result: [CGRect] = []
        for region in regions.sorted(by: { $0.minY < $1.minY }) {
            if let last = result.last, region.minY <= last.maxY {
                result[result.count - 1] = last.union(region)
            } else { result.append(region) }
        }
        return result
    }

    /// Minimum-cost partition of contiguous bands, including the one-union alternative.
    /// No fixed maximum draw count: an extra draw must save more pixel work than it costs.
    static func plan(_ regions: [CGRect], scale: CGFloat, drawsPerPass: Int = 1,
                     model: NativeUICaptureCostModel = .default, windowWidth: CGFloat? = nil, nativeScale: CGFloat? = nil) -> [CGRect] {
        let bands = bands(regions)
        guard !bands.isEmpty else { return [] }
        var costs = [Double](repeating: .infinity, count: bands.count + 1)
        var counts = [Int](repeating: Int.max, count: bands.count + 1)
        var previous = [Int](repeating: 0, count: bands.count + 1)
        costs[0] = 0; counts[0] = 0
        for end in 1...bands.count {
            var rect = CGRect.null
            for start in stride(from: end - 1, through: 0, by: -1) {
                rect = rect.union(bands[start])
                let value = costs[start] + model.cost(rect, scale: scale, drawsPerPass: max(1, drawsPerPass), windowWidth: windowWidth, nativeScale: nativeScale)
                let count = counts[start] + 1
                if value < costs[end] - 0.000_001 || (abs(value - costs[end]) <= 0.000_001 && count < counts[end]) {
                    costs[end] = value; counts[end] = count; previous[end] = start
                }
            }
        }
        var result: [CGRect] = []
        var end = bands.count
        while end > 0 {
            let start = previous[end]
            result.append(bands[start..<end].reduce(CGRect.null) { $0.union($1) })
            end = start
        }
        return result.reversed()
    }
}
