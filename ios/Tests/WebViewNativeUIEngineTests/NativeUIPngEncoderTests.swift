// Test fixtures fail immediately when required setup values are missing.
import XCTest
import CoreImage
import ImageIO
@testable import WebViewNativeUIEngine

final class NativeUIPngEncoderTests: XCTestCase {
    func testSixteenBitP3PixelsAndTransparentAlphaMatchPlatformEncoder() throws {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
        // Asymmetric rows expose vertical flips; out-of-range samples expose clipping differences.
        let samples: [Float] = [1.1, 0.2, 0.3, 1, 0.1, 0.7, 0.2, 0.5,
                                0.8, 0.1, 0.4, 0.25, 0, 0, 0, 0]
        let source = samples.withUnsafeBytes { bytes in
            CIImage(bitmapData: Data(bytes), bytesPerRow: 32, size: CGSize(width: 2, height: 2),
                    format: .RGBAf, colorSpace: space)
        }
        let rust = try XCTUnwrap(NativeUIPngEncoder().encode(source, colorSpace: space))
        let reference = try XCTUnwrap(CIContext().pngRepresentation(of: source, format: .RGBA16,
                                                                  colorSpace: space, options: [:]))
        let decoded = try decode(rust)
        XCTAssertEqual(decoded.bitsPerComponent, 16)
        XCTAssertEqual(decoded.colorSpace?.name, CGColorSpace.displayP3)
        let actual = try pixels(decoded, colorSpace: space)
        let expected = try pixels(try decode(reference), colorSpace: space)
        XCTAssertEqual(actual.count, expected.count)
        for (index, pair) in zip(actual, expected).enumerated() {
            XCTAssertEqual(Double(pair.0), Double(pair.1), accuracy: 1, "16-bit sample \(index)")
        }
    }

    func testInvalidExtentRequestsFallback() throws {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
        XCTAssertNil(NativeUIPngEncoder().encode(CIImage.empty(), colorSpace: space))
        XCTAssertNil(NativeUIPngEncoder().encode(CIImage(color: .red), colorSpace: space))
    }

    private func decode(_ png: Data) throws -> CGImage {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }

    private func pixels(_ image: CGImage, colorSpace: CGColorSpace) throws -> [UInt16] {
        var result = [UInt16](repeating: 0, count: image.width * image.height * 4)
        try result.withUnsafeMutableBytes { bytes in
            let base = try XCTUnwrap(bytes.baseAddress)
            CIContext(options: [.outputPremultiplied: false]).render(CIImage(cgImage: image),
                toBitmap: base, rowBytes: image.width * 8,
                bounds: CGRect(x: 0, y: 0, width: image.width, height: image.height), format: .RGBA16,
                colorSpace: colorSpace)
        }
        return result
    }
}
