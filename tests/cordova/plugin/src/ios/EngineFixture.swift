// @webview-native-ui/engine
// Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
// SPDX-License-Identifier: MIT

// Test fixtures fail immediately when required setup values are missing.
// swiftlint:disable force_unwrapping force_cast force_try
import Cordova
import WebKit
import WebViewNativeUIEngine

@objc(EngineFixture)
final class EngineFixture: CDVPlugin {
    private var projection: NativeUIProjection?
    private let native = UILabel()
    override func pluginInitialize() {
        guard let web = webView as? WKWebView else { return }
        native.text = "Native Engine"; native.textColor = .white; native.backgroundColor = .systemBlue
        web.superview?.addSubview(native)
        do {
            projection = try NativeUIProjection(webView: web, plugin: "EngineFixture", projectionSelector: "#slot",
                                                receiveListeners: .init(
                                                    update: ["updated"],
                                                    projection: .init(native: ["native"], web: ["web"], none: ["none"])
                                                ),
                                                runtime: .cordova, view: { [weak self] in self?.native })
        } catch { print("Engine init: \(error)") }
    }
    @objc func place(_ command: CDVInvokedUrlCommand) {
        let rect = command.arguments[0] as! [String: Double]
        if let web = webView as? WKWebView, let parent = native.superview {
            let scale = web.bounds.width / rect["viewport"]!
            native.frame = web.convert(
                CGRect(x: rect["x"]!*scale, y: rect["y"]!*scale, width: rect["width"]!*scale, height: rect["height"]!*scale),
                to: parent
            )
            projection?.receive("updated")
        }
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }
    @objc(native:) func showNative(_ command: CDVInvokedUrlCommand) { route("native", command) }
    @objc(web:) func showWeb(_ command: CDVInvokedUrlCommand) { route("web", command) }
    @objc(none:) func hide(_ command: CDVInvokedUrlCommand) { route("none", command) }
    private func route(_ event: String, _ command: CDVInvokedUrlCommand) {
        projection?.receive(event)
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }
    @objc func status(_ command: CDVInvokedUrlCommand) {
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK, messageAs: ["visible": !native.isHidden]), callbackId: command.callbackId)
    }
    @objc func report(_ command: CDVInvokedUrlCommand) {
        let data = try! JSONSerialization.data(withJSONObject: command.arguments[0])
        try! data.write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("engine-result.json"))
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }
    override func dispose() { projection?.destroy(); projection=nil; native.removeFromSuperview(); super.dispose() }
}

// swiftlint:enable force_unwrapping force_cast force_try
