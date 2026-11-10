// swift-tools-version: 5.9
import PackageDescription
let package = Package(
 name: "WebViewNativeUIEngine", platforms: [.iOS(.v15)],
 products: [.library(name: "WebViewNativeUIEngine", targets: ["WebViewNativeUIEngine"]),
 .library(name: "WebViewNativeUIControls", targets: ["WebViewNativeUIControls"])],
 targets: [
  .testTarget(name: "WebViewNativeUIControlsTests", dependencies: ["WebViewNativeUIControls"], path: "ios/Tests/WebViewNativeUIControlsTests"),
  .target(name: "WebViewNativeUIControls", dependencies: ["WebViewNativeUIEngine"], path: "ios/Sources/WebViewNativeUIControls"),
  .binaryTarget(name: "NativeUIPng", path: "native/artifacts/NativeUIPng.xcframework"),
  .target(name: "WebViewNativeUIEngine", dependencies: ["NativeUIPng"], path: "ios/Sources/WebViewNativeUIEngine", resources: [.process("Resources")]),
  .testTarget(name: "WebViewNativeUIEngineTests", dependencies: ["WebViewNativeUIEngine"], path: "ios/Tests/WebViewNativeUIEngineTests")
 ])
