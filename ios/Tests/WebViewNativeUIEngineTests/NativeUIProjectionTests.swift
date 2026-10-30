// @webview-native-ui/engine
// Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
// SPDX-License-Identifier: MIT

// Test fixtures fail immediately when required setup values are missing.
// swiftlint:disable force_unwrapping force_cast
import XCTest
import WebKit
@testable import WebViewNativeUIEngine

final class NativeUIProjectionTests: XCTestCase {
    func testConfiguredApplicationOriginsExcludeNavigationDestinations() throws {
        let origins = try ProjectionOrigins.configured(["server": [
            "iosScheme": "myapp", "hostname": "app.example",
            "url": "https://User:password@DEV.example:443/path?query=1#fragment",
            "allowNavigation": ["untrusted.example", "*"]
        ]])
        XCTAssertEqual(origins, ["https://dev.example"])
        XCTAssertEqual(try ProjectionOrigins.configured(["server": ["iosScheme": "myapp", "hostname": "app.example"]]), ["myapp://app.example"])
        XCTAssertEqual(try ProjectionOrigins.configured([:]), ProjectionOrigins.defaults)
        XCTAssertEqual(try ProjectionOrigins.configured(["server": [:]]), ["capacitor://localhost"])
    }

    func testReservedSchemeUsesCapacitorFallback() throws {
        XCTAssertEqual(try ProjectionOrigins.configured(["server": ["iosScheme": "https"]]), ["capacitor://localhost"])
    }

    func testConfiguredURLPreservesPortAndRejectsWildcard() throws {
        XCTAssertEqual(try ProjectionOrigins.configured(["server": ["url": "http://LOCALHOST:8080/path"]]), ["http://localhost:8080"])
        XCTAssertThrowsError(try ProjectionOrigins.configured(["server": ["url": "https://*.example.com"]]))
    }

    func testReadsBundledCapacitorConfiguration() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("{\"server\":{\"hostname\":\"configured.example\"}}".utf8)
            .write(to: directory.appendingPathComponent("capacitor.config.json"))
        let bundle = try XCTUnwrap(Bundle(url: directory))
        XCTAssertEqual(try ProjectionOrigins.configured(in: bundle), ["capacitor://configured.example"])
    }

    @MainActor func testMissingWebViewThrowsDuringInitialization() {
        XCTAssertThrowsError(try NativeUIProjection(
            webView: nil, plugin: "Fixture", projectionSelector: "#slot", view: { nil }
        ))
    }

    @MainActor func testConvenienceInitializerForwardsNativeFailurePolicy() throws {
        let web = WKWebView()
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                  failedFallback: .native, captureDelayMs: 600, canCapture: { false }, view: { nil })
        defer { registration.destroy() }
        XCTAssertTrue(web.configuration.userContentController.userScripts.contains {
            $0.source.contains("\"failedFallback\":\"native\"") && $0.source.contains("\"captureDelayMs\":600")
        })
    }

    @MainActor func testNativeInitializationFallbackEventsReloadAndTeardown() async throws {
        let configuration = WKWebViewConfiguration()
        let content = ProjectionFixture()
        configuration.setURLSchemeHandler(content, forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.testDocument = Math.random().toString(36);
          window.testEvents = {};
          window.Capacitor = {
            addListener: (plugin, name, listener) => { testEvents[name] = listener; return { remove: async () => { delete testEvents[name]; } }; },
            convertFileSrc: url => 'capacitor://configured.example/_capacitor_file_' + url.replace('file://', '')
          };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = UIWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
        let web = WKWebView(frame: window.bounds, configuration: configuration)
        owner.view.addSubview(web)
        let button = UIButton(frame: CGRect(x: 20, y: 100, width: 100, height: 40))
        button.backgroundColor = .red; button.setTitle("Native", for: .normal)
        let surface = UIView(frame: CGRect(x: 20, y: 100, width: 100, height: 100))
        button.frame.origin = .zero
        surface.addSubview(button)
        owner.view.addSubview(surface)
        let hidden = UIView(frame: CGRect(x: 20, y: 160, width: 100, height: 40)); hidden.isHidden = true
        hidden.frame.origin = CGPoint(x: 0, y: 60)
        surface.addSubview(hidden)
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                  receiveListeners: .init(
                                                    update: ["updated"],
                                                    projection: .init(native: ["shown"], web: ["moving"], none: ["hidden"])
                                                  ),
                                                  allowedOrigins: try ProjectionOrigins.configured(["server": ["hostname": "configured.example"]]),
                                                  readValues: { ["label": button.title(for: .normal) ?? ""] },
                                                  canCapture: { false }, view: { surface })
        defer { registration.destroy(); window.isHidden = true }
        web.load(URLRequest(url: URL(string: "capacitor://configured.example/fixture")!))
        try await wait(web,
                       "document.querySelector('#slot')?.getAttributeNames()" +
                        ".some(n => n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='native') === true", timeout: 30)
        XCTAssertFalse(surface.isHidden)
        try await wait(web, "document.querySelector('#slot')?.dataset.nativeUiValueLabel === 'Native'")
        button.setTitle("Changed", for: .normal)
        _ = try await web.evaluateJavaScript("testEvents.updated({})")
        try await wait(web, "document.querySelector('#slot')?.dataset.nativeUiValueLabel === 'Changed'")
        for _ in 0..<2 {
            _ = try await web.evaluateJavaScript("testEvents.moving({})")
            try await wait(web, "!document.querySelector('#slot').getAttributeNames().some(n => n.startsWith('data-native-ui-session-'))")
            // Capture is unavailable (for example, an SDK video view). Verify normal Web fallback.
            for _ in 0..<100 where !surface.isHidden { try await Task.sleep(nanoseconds: 20_000_000) }
            XCTAssertTrue(surface.isHidden)
            _ = try await web.evaluateJavaScript("testEvents.shown({})")
            try await wait(web,
                           "document.querySelector('#slot').getAttributeNames()" +
                            ".some(n => n.startsWith('data-native-ui-session-')" +
                            " && document.querySelector('#slot').getAttribute(n)==='native')")
            XCTAssertFalse(surface.isHidden)
            XCTAssertTrue(hidden.isHidden, "Do not unhide a renderer-owned hidden view")
        }
        _ = try await web.evaluateJavaScript("testEvents.hidden({})")
        try await wait(web,
                       "document.querySelector('#slot').getAttributeNames()" +
                        ".some(n => n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='none')")
        XCTAssertTrue(surface.isHidden)
        let previousDocument = try await web.evaluateJavaScript("testDocument") as! String
        web.reload()
        try await wait(web, "typeof testDocument === 'string' && testDocument !== '\(previousDocument)'")
        try await wait(web,
                       "document.querySelector('#slot')?.getAttributeNames()" +
                        ".some(n => n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='none') === true")
        XCTAssertTrue(surface.isHidden, "Reload must preserve none")
        _ = try await web.evaluateJavaScript("testEvents.shown({})")
        try await wait(web,
                       "document.querySelector('#slot')?.getAttributeNames()" +
                        ".some(n => n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='native') === true")
        XCTAssertFalse(surface.isHidden)
        registration.destroy()
        try await wait(web, "Object.keys(testEvents).length === 0")
        XCTAssertEqual(configuration.userContentController.userScripts.count, 1, "Keep the host's scripts")
    }
    @MainActor func testScrollMasksFollowTheirViewsAcrossReplacementAndDocumentReset() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(ProjectionFixture(), forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.testReply = null;
          window.WebViewNativeUIEngineRuntime = {
            start: async () => {}, stop: () => {},
            receive: (id, key, value) => { window.testReply = value; }
          };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = UIWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
        let web = WKWebView(frame: window.bounds, configuration: configuration)
        owner.view.addSubview(web)
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 80, width: 320, height: 500))
        scroll.contentSize = CGSize(width: 320, height: 1200)
        web.addSubview(scroll)
        let first = UIView(frame: CGRect(x: 10, y: 100, width: 100, height: 40))
        let second = UIView(frame: first.frame)
        owner.view.addSubview(first); owner.view.addSubview(second)
        var current = first
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#absent",
                                                  canCapture: { false }, view: { current })
        defer { registration.destroy(); window.isHidden = true }
        web.load(URLRequest(url: URL(string: "capacitor://localhost/fixture")!))
        try await wait(web, "document.readyState === 'complete' && location.host === 'localhost'")
        let script = try XCTUnwrap(configuration.userContentController.userScripts.last?.source)
        let id = String(script[try XCTUnwrap(script.range(of: "nativeUI[0-9A-F]{32}", options: .regularExpression))])
        func send(_ action: String, page: String = "maskTest") async throws {
            _ = try await web.evaluateJavaScript("""
            (() => {
              const id = '\(id)';
              window.testReply = null;
              webkit.messageHandlers[id].postMessage(JSON.stringify({key: id + ':\(page):1', request: {
                action: '\(action)', viewportWidth: \(web.bounds.width),
                scroll: {id:'scroll',offsetX:0,offsetY:0,viewport:{x:0,y:80,width:320,height:500},
                  clip:{x:0,y:100,width:320,height:480},contentWidth:320,contentHeight:1200,
                  frame:{x:10,y:20,width:100,height:40}}
              }}));
            })()
            """)
            try await wait(web, "testReply !== null")
        }
        try await send("track")
        scroll.contentOffset.y = 10
        XCTAssertNotNil(first.layer.mask)
        current = second
        try await send("track")
        XCTAssertNil(first.layer.mask, "Release the original view, not the replacement from the provider")
        scroll.contentOffset.y = 20
        XCTAssertNotNil(second.layer.mask)
        try await send("connect", page: "nextDocument")
        XCTAssertNil(second.layer.mask, "Changing documents must release scroll clipping")
        try await send("track", page: "nextDocument")
        scroll.contentOffset.y = 30
        XCTAssertNotNil(second.layer.mask)
        let rendererMask = CAShapeLayer()
        second.layer.mask = rendererMask
        try await send("track", page: "nextDocument")
        XCTAssertTrue(second.layer.mask === rendererMask, "Do not remove a mask installed later by the renderer")
        second.layer.mask = nil
        current = first
        try await send("track", page: "nextDocument")
        scroll.contentOffset.y = 40
        XCTAssertNotNil(first.layer.mask)
        current = second
        registration.destroy()
        XCTAssertNil(first.layer.mask, "Teardown must release the previously bound view")
    }

    @MainActor func testPreparedImageReturnsToNativeAfterWebProjection() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(ProjectionFixture(), forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.testEvents = {};
          window.Capacitor = {
            addListener: (plugin, name, listener) => { testEvents[name] = listener; return { remove: async () => { delete testEvents[name]; } }; },
            convertFileSrc: url => 'capacitor://localhost/_capacitor_file_' + url.replace('file://', '')
          };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
        let web = WKWebView(frame: window.bounds, configuration: configuration)
        owner.view.addSubview(web)
        let button = UIButton(frame: CGRect(x: 20, y: 100, width: 100, height: 40))
        button.backgroundColor = .red; button.setTitle("Native", for: .normal)
        owner.view.addSubview(button)
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                  receiveListeners: .init(projection: .init(native: ["shown"], web: ["moving"])),
                                                  // SnapshotTestWindow supplies deterministic pixels in hostless XCTest.
                                                  // Capture, file transport and handoff use the production path.
                                                  snapshots: NativeUICoveredSnapshots(), view: { button })
        defer { registration.destroy(); window.isHidden = true }
        web.load(URLRequest(url: URL(string: "capacitor://localhost/fixture")!))
        for _ in 0..<3 {
            try await wait(web, "document.querySelector('#slot')?.hasAttribute('data-native-ui-snapshot') === true", timeout: 30)
            try await wait(web, "document.querySelector('#slot > img[data-native-ui-projection-image]') !== null")
            XCTAssertFalse(button.isHidden)
            _ = try await web.evaluateJavaScript("testEvents.moving({})")
            try await wait(web, "document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')")
            XCTAssertTrue(button.isHidden)
            _ = try await web.evaluateJavaScript("testEvents.shown({})")
            try await wait(web,
                           "document.querySelector('#slot').getAttributeNames()" +
                            ".some(n => n.startsWith('data-native-ui-session-')" +
                            " && document.querySelector('#slot').getAttribute(n)==='native')" +
                            " && !document.querySelector('#slot').hasAttribute('data-native-ui-snapshot-visible')")
            XCTAssertFalse(button.isHidden, "Prepared image handoff must restore the live view")
            XCTAssertEqual(button.frame, CGRect(x: 20, y: 100, width: 100, height: 40))
        }
    }
    @MainActor func testNotificationBeforeSubscriptionsPreservesLatestMatchingDestination() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(ProjectionFixture(), forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.testEvents = {};
          window.Capacitor = { addListener: (plugin, name, listener) => {
            testEvents[name] = listener; return { remove: async () => { delete testEvents[name]; } };
          } };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = UIWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
        let web = WKWebView(frame: window.bounds, configuration: configuration)
        owner.view.addSubview(web)
        let native = UIView(frame: CGRect(x: 20, y: 100, width: 100, height: 40)); owner.view.addSubview(native)
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                  receiveListeners: .init(
                                                    projection: .init(native: ["shown"], web: ["moving"], none: ["hidden"]),
                                                    match: ["slot": "one"]
                                                  ), canCapture: { false }, view: { native })
        defer { registration.destroy(); window.isHidden = true }
        // A notification during startup has no subscriber yet; the current state remains authoritative.
        registration.receive("hidden", data: ["slot": "one"])
        registration.receive("moving", data: ["slot": "one"])
        registration.receive("shown", data: ["slot": "other"])
        web.load(URLRequest(url: URL(string: "capacitor://localhost/fixture")!))
        try await wait(web, "typeof testEvents?.shown === 'function'", timeout: 30)
        for _ in 0..<100 where !native.isHidden { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(native.isHidden)
        let webVisible = try await web.evaluateJavaScript("getComputedStyle(document.querySelector('#slot')).visibility === 'visible'") as? Bool
        XCTAssertEqual(webVisible, true)
        registration.receive("shown", data: ["slot": "one"])
        _ = try await web.evaluateJavaScript("testEvents.shown({slot: 'one'})")
        try await wait(web,
                       "document.querySelector('#slot').getAttributeNames()" +
                        ".some(n=>n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='native')")
        XCTAssertFalse(native.isHidden)
        web.reload()
        try await wait(web,
                       "document.querySelector('#slot')?.getAttributeNames()" +
                        ".some(n=>n.startsWith('data-native-ui-session-')" +
                        " && document.querySelector('#slot').getAttribute(n)==='native') === true")
        XCTAssertFalse(native.isHidden, "Reconnection must use the latest native notification")
    }
    @MainActor func testCordovaNotificationsAndTeardownDoNotReachUntrustedNavigation() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(ProjectionFixture(), forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.calls = [];
          window.WebViewNativeUIEngineRuntime = {
            start: async () => {},
            notify: (...args) => calls.push(args),
            receive: (...args) => calls.push(args),
            stop: (...args) => calls.push(args)
          };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = UIWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
        let web = WKWebView(frame: window.bounds, configuration: configuration)
        owner.view.addSubview(web)
        let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                  receiveListeners: .init(update: ["updated"]), runtime: .cordova, view: { nil })
        defer { registration.destroy(); window.isHidden = true }
        web.load(URLRequest(url: URL(string: "capacitor://localhost/fixture")!))
        // A cold CI simulator may need tens of seconds to launch WebKit processes.
        // Keep this startup allowance separate from the notification assertions below.
        try await wait(web, "location.host === 'localhost' && typeof calls !== 'undefined'", timeout: 60)
        registration.receive("updated", data: ["value": "private"])
        try await wait(web, "calls.length === 1")
        web.load(URLRequest(url: URL(string: "capacitor://untrusted.example/fixture")!))
        try await wait(web, "location.host === 'untrusted.example' && typeof calls !== 'undefined'")
        registration.receive("updated", data: ["value": "private"])
        // receive dispatches onto the main queue; drain it before the ordered WebKit check.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
        registration.destroy()
        let calls = try await web.evaluateJavaScript("calls.length") as? Int
        XCTAssertEqual(calls, 0, "Native data and lifecycle messages must obey the allowed origin after navigation")
    }

    @MainActor func testHideAndImmediateTeardownPreservesRendererVisibility() async throws {
        for capture in [false, true] {
            let configuration = WKWebViewConfiguration()
            configuration.setURLSchemeHandler(ProjectionFixture(), forURLScheme: "capacitor")
            configuration.userContentController.addUserScript(WKUserScript(source: """
              window.Capacitor = { convertFileSrc: url => 'capacitor://localhost/_capacitor_file_' + url.replace('file://', '') };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            let window = SnapshotTestWindow(frame: UIScreen.main.bounds)
            let owner = UIViewController(); window.rootViewController = owner; window.makeKeyAndVisible()
            let web = WKWebView(frame: window.bounds, configuration: configuration)
            owner.view.addSubview(web)
            let native = UIView(frame: CGRect(x: 20, y: 100, width: 100, height: 40))
            native.backgroundColor = .red; owner.view.addSubview(native)
            var current: UIView? = native
            let registration = try NativeUIProjection(webView: web, plugin: "Fixture", projectionSelector: "#slot",
                                                      receiveListeners: .init(projection: .init(web: ["moving"], none: ["hidden"])),
                                                      runtime: .cordova, canCapture: { capture }, view: { current })
            defer { registration.destroy(); window.isHidden = true }
            web.load(URLRequest(url: URL(string: "capacitor://localhost/fixture")!))
            try await wait(web, "document.querySelector('#slot')?.getAttribute('data-native-ui-destination') === 'native'", timeout: 30)
            if capture { try await wait(web, "document.querySelector('#slot').hasAttribute('data-native-ui-snapshot')") }
            registration.receive("moving")
            try await wait(web, "document.querySelector('#slot')?.getAttribute('data-native-ui-destination') === 'web'")
            for _ in 0..<100 where !native.isHidden { try await Task.sleep(nanoseconds: 20_000_000) }
            XCTAssertTrue(native.isHidden)
            // Plugin hide and teardown occur before the Web runtime can acknowledge the notification.
            native.isHidden = true
            registration.receive("hidden")
            current = nil
            registration.destroy()
            XCTAssertTrue(native.isHidden, "Teardown must not undo renderer hide (capture: \(capture))")
        }
    }

    @MainActor private func wait(_ web: WKWebView, _ expression: String, timeout: TimeInterval = 8) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (try? await web.evaluateJavaScript(expression)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out: \(expression)")
        throw NSError(domain: "ProjectionFixture", code: 1)
    }
}
private final class ProjectionFixture: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url!
        let data: Data
        let type: String
        if url.path.hasPrefix("/_capacitor_file_") {
            let path = String(url.path.dropFirst("/_capacitor_file_".count))
            guard path.hasPrefix(NSTemporaryDirectory()), let image = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
                urlSchemeTask.didFailWithError(NSError(domain: "ProjectionFixture", code: 2)); return
            }
            data = image; type = "image/png"
        } else {
            data = Data((
                "<meta name='viewport' content='width=device-width,initial-scale=1'><body>" +
                    "<div id='slot' style='position:absolute;left:20px;top:100px;width:100px;height:40px'>Fallback</div></body>"
            ).utf8)
            type = "text/html"
        }
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: type, expectedContentLength: data.count, textEncodingName: nil))
        urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
// swiftlint:enable force_unwrapping force_cast
