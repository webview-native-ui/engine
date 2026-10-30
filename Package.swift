// swift-tools-version: 5.9
// @webview-native-ui/engine
// Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
// SPDX-License-Identifier: MIT

import PackageDescription
let package = Package(
 name: "WebViewNativeUIEngine", platforms: [.iOS(.v15)],
 products: [.library(name: "WebViewNativeUIEngine", targets: ["WebViewNativeUIEngine"])],
 targets: [
  .target(name: "WebViewNativeUIEngine", path: "ios/Sources/WebViewNativeUIEngine", resources: [.process("Resources")]),
  .testTarget(name: "WebViewNativeUIEngineTests", dependencies: ["WebViewNativeUIEngine"], path: "ios/Tests/WebViewNativeUIEngineTests")
 ])
