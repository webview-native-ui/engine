// swift-tools-version: 5.9
import PackageDescription
let package = Package(
 name: "WebViewNativeUIEngine", platforms: [.iOS(.v15)],
 products: [.library(name: "WebViewNativeUIEngine", targets: ["WebViewNativeUIEngine"]),
 .library(name: "WebViewNativeUIControls", targets: ["WebViewNativeUIControls"])],
 targets: [
  .target(name: "NativeUIGlassCapture", path: "ios/Sources/NativeUIGlassCapture", publicHeadersPath: "include"),
  .testTarget(name: "NativeUIGlassCaptureTests", dependencies: ["NativeUIGlassCapture"], path: "ios/Tests/NativeUIGlassCaptureTests"),
  .testTarget(name: "WebViewNativeUIControlsTests", dependencies: ["WebViewNativeUIControls"], path: "ios/Tests/WebViewNativeUIControlsTests"),
  .target(name: "WebViewNativeUIControls", dependencies: ["WebViewNativeUIEngine"], path: "ios/Sources/WebViewNativeUIControls"),
  .binaryTarget(name: "NativeUIPng", path: "native/artifacts/NativeUIPng.xcframework"),
  .target(name: "WebViewNativeUIEngine", dependencies: ["NativeUIPng", "NativeUIGlassCapture"], path: "ios/Sources/WebViewNativeUIEngine", resources: [.process("Resources")]),
  .testTarget(name: "WebViewNativeUIEngineTests", dependencies: ["WebViewNativeUIEngine"], path: "ios/Tests/WebViewNativeUIEngineTests")
 ])
