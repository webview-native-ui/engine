import CoreImage
import NativeUIPng

/// Encodes the existing integer-16 Display P3 output without reducing color precision.
/// The caller retains ImageIO's encoder as a fallback if native encoding fails.
final class NativeUIPngEncoder {
    private let context = CIContext(options: [.outputPremultiplied: false])

    func encode(_ image: CIImage, colorSpace: CGColorSpace) -> Data? {
        let bounds = image.extent
        guard bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0, bounds.width <= 8_000_000,
              bounds.height <= 8_000_000 else { return nil }
        let width = Int(bounds.width), height = Int(bounds.height)
        guard width > 0, height > 0, width <= 8_000_000 / height,
              let profile = colorSpace.copyICCData() as Data?, !profile.isEmpty else { return nil }
        let stride = width * 8
        var pixels = Data(count: stride * height)
        pixels.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            context.render(image, toBitmap: base, rowBytes: stride, bounds: bounds,
                           format: .RGBA16, colorSpace: colorSpace)
        }
        var output = NativeUIPngBuffer(data: nil, len: 0)
        let status = pixels.withUnsafeBytes { bytes in
            profile.withUnsafeBytes { icc in
                native_ui_png_encode(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count,
                                     UInt32(width), UInt32(height), stride, 16, 1,
                                     icc.bindMemory(to: UInt8.self).baseAddress, icc.count, &output)
            }
        }
        guard status == 0, let data = output.data, output.len > 0 else { return nil }
        // Transfer ownership directly to Foundation. The Rust allocation is released once.
        return Data(bytesNoCopy: data, count: output.len, deallocator: .custom { pointer, count in
            native_ui_png_free(NativeUIPngBuffer(data: pointer.assumingMemoryBound(to: UInt8.self), len: count))
        })
    }
}
