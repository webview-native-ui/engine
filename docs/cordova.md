# Cordova plugin integration

The same npm package, Swift library and Android AAR support Capacitor and Cordova. Engine is a library used by plugin maintainers, not a separately registered Cordova plugin. A Cordova application does not need `@capacitor/core` or a Capacitor native SDK.

The consuming plugin still owns its native view and the corresponding DOM, including placement, size and stacking order. Supply an existing selector such as `native-ad` or `#player`. The DOM may be added after initialization. Image preparation, scroll handling, overlays and restoration use the common Engine implementation.

## iOS

Use the same SwiftPM dependency described in the main README. In a Cordova SwiftPM plugin, declare both Cordova and Engine as dependencies of the plugin target; neither framework becomes a dependency of the Engine target.

```swift
import Cordova
import WebKit
import CapacitorNativeUIEngine

@objc(ExamplePlugin)
class ExamplePlugin: CDVPlugin {
    private var projection: NativeUIProjection?
    private var nativeView: UIView?

    override func pluginInitialize() {
        do {
            projection = try NativeUIProjection(
                webView: webView as? WKWebView,
                plugin: "ExamplePlugin",
                projectionSelector: "#player",
                receiveListeners: .init(
                    update: ["contentChanged"],
                    projection: .init(native: ["shown"], web: ["covered"], none: ["hidden"])
                ),
                runtime: .cordova,
                view: { [weak self] in self?.nativeView }
            )
        } catch {
            // Keep the existing Web fallback when registration is unavailable.
            NSLog("Native UI projection unavailable: %@", String(describing: error))
        }
    }

    override func dispose() {
        projection?.destroy()
        projection = nil
        super.dispose()
    }
}
```

Forward the plugin's existing presentation/content notifications with `projection?.receive("shown")`, `receive("hidden")` or `receive("contentChanged")`. Put this alongside the existing callback/event delivery, or in the plugin's shared notification method. `receive` updates the Engine session only: it does not deliver a second application callback. A matching destination emitted before JS startup is retained for the initial connection.

Cordova iOS's built-in `WkWebView.convertFilePath` serves the prepared PNGs. Engine resolves this internally. No file plugin, additional permission or author-provided URL converter is required. The default allowed origins include `app://localhost`; pass the actual trusted origin if the app changes its scheme or hostname.

## Android

Declare the Maven dependency in the existing Cordova plugin Gradle configuration. Also declare `implementation 'androidx.webkit:webkit:1.14.0'` when using the `CordovaPluginPathHandler` signature; Cordova's internal WebKit dependency is not exposed on the plugin compile classpath. The plugin's `plugin.xml` must initialize it before the first WebView navigation:

```xml
<feature name="ExamplePlugin">
    <param name="android-package" value="com.example.ExamplePlugin" />
    <param name="onload" value="true" />
</feature>
```

```kotlin
class ExamplePlugin : CordovaPlugin() {
    private var projection: NativeUIProjection? = null
    private var nativeView: View? = null

    override fun pluginInitialize() {
        val web = webView.view as WebView
        // One origin-restricted channel per WebView, shared with later registrations.
        NativeUIProjection.install(web)
        projection = NativeUIProjection(
            window = cordova.activity.window,
            webView = web,
            plugin = serviceName,
            projectionSelector = "#player",
            receiveListeners = NativeUIProjection.ReceiveListeners(
                update = listOf("contentChanged"),
                projection = NativeUIProjection.ReceiveListeners.Projection(
                    native = listOf("shown"), web = listOf("covered"), none = listOf("hidden")
                )
            ),
            runtime = NativeUIProjection.Runtime.CORDOVA,
            view = { nativeView }
        )
    }

    override fun getPathHandler() = CordovaPluginPathHandler { path ->
        projection?.handleResource(path)
    }

    override fun onDestroy() {
        projection?.close()
        projection = null
        super.onDestroy()
    }
}
```

Use `projection?.receive(eventName, data)` at the existing notification point, as on iOS. Native view creation and placement remain on the UI thread.

The `PathHandler` delegates same-origin image requests to Engine. It serves only the registration's PNG files in app-private cache storage; unrelated paths return `null`. If the plugin already has a handler, combine them with `projection?.handleResource(path) ?: existingHandler.handle(path)`. For multiple registrations, delegate to the matching owner. Keep the handler installed for the WebView lifetime. No WebViewClient replacement or storage permission is needed.

The defaults support Cordova's `https://localhost` and `http://localhost`. If the hostname changes, pass the same explicit origin set to `install` and each registration. Wildcard origins and `file://` app origins are not supported by this integration.

## Lifetime and verification

Keep the registration for the WebView lifetime. Engine reconnects after a document reload and clears the old document's image state. If the plugin destroys its native UI in `onReset`, update its view provider and emit the appropriate destination; do not leave a registration pointing at a destroyed view. Dispose registrations when the plugin/WebView is destroyed.

Capacitor registrations retain their existing default. Explicit `runtime: cordova` also avoids accidental Capacitor event subscriptions when a Cordova plugin runs inside a Capacitor app. Ionic overlay observation remains optional and shared through `enableSupportIonicOverlays`; plain Cordova apps need not enable it.

The integration fixture uses Cordova CLI 13, cordova-ios 8.1.1 and cordova-android 15.1.0 with their standard WebViews. It checks actual PNG handoff, native restoration and hidden-state retention across document reload, not merely JS bridge mocks. Older Cordova releases and custom WebView engines require separate verification.

Run the real consumer checks with an already booted simulator/emulator:

```sh
npm run test:cordova -- ios SIMULATOR_UDID
npm run test:cordova -- android emulator-5554
```

The script creates a disposable app, uses local SwiftPM/Maven Engine artifacts, and records the application result in the printed temporary directory. It never publishes to npm or Maven. Android requires JDK 21+, SDK 36 and `ANDROID_HOME`; iOS requires Xcode.
