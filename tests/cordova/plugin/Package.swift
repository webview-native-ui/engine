// swift-tools-version: 5.9
import PackageDescription
import Foundation
let engine = ProcessInfo.processInfo.environment["NATIVE_UI_ENGINE_SOURCE"]!
let package = Package(
    name: "EngineFixture", platforms: [.iOS(.v15)],
    products: [.library(name: "native-ui-engine-cordova-fixture", targets: ["EngineFixture"])],
    dependencies: [
        .package(url: "https://github.com/apache/cordova-ios.git", from: "8.0.0"),
        .package(name: "engine", path: engine)
    ],
    targets: [.target(name: "EngineFixture", dependencies: [
        .product(name: "Cordova", package: "cordova-ios"),
        .product(name: "WebViewNativeUIEngine", package: "engine")
    ], path: "src/ios")]
)
