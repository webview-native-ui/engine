# Cordova plugin integration

The same npm package, Swift library and Android AAR support Capacitor and Cordova. Engine is a library used by plugin maintainers, not a separately registered Cordova plugin. A Cordova application does not need `@capacitor/core` or a Capacitor native SDK.

The consuming plugin still owns its native view and the corresponding DOM, including placement, size and stacking order. Supply an existing selector such as `native-ad` or `#player`. The DOM may be added after initialization. Image preparation, scroll handling, overlays and restoration use the common Engine implementation.

## What this integration gives you

A native control can remain interactive during normal use, then yield its visual
presentation to a prepared image when a Web overlay or unsupported motion needs
the DOM layer. Once native placement is ready again, the Engine restores the live
view. This avoids rebuilding capture, image readiness and restoration coordination
inside each plugin. See [concepts and limits](concepts.md) before choosing a fallback
for content that cannot be captured.

The steps below connect three things: your native view, an existing DOM container
at the intended Web layer, and notifications describing successful appearance or
presentation changes. The Engine needs those notifications because a native API
call alone does not tell it when your control's visible state has changed.

## Requirements

The integration is verified with cordova-ios 8.1.1 and cordova-android 15.1.0 using their standard WebViews. The Engine itself requires iOS 15+ and Android API 23+; the Cordova host or SDK may require a higher minimum. Composited Android capture requires API 26+.

## Choose the Web destination

Provide a laid-out container such as `native-ad` or `#player` in the layer where
the projected appearance should live. It may be inserted after registration, but
must exist when projection starts. The native view's rectangle cannot identify
its intended place in the DOM stacking tree. Check the
[container support table](projection-containers.md) before choosing the selector.
For Ionic applications, add [overlay support](ionic-overlays.md) once; other
frameworks report their own transition lifecycle through notifications.

## Dependencies

Replace `<engine-version>` in every dependency below with the same published
release. Read that release tag’s documentation so the examples match its APIs.

Use the same Engine release for the Web package and native libraries. The API is pre-1.0; pin versions and retain dependency lockfiles.

```sh
npm install --save-exact '@webview-native-ui/engine@<engine-version>'
```

Declare the native dependencies in the consuming plugin as well. npm installation alone does not link either native library.

For Swift Package Manager:

```swift
.package(url: "https://github.com/webview-native-ui/engine.git", exact: "<engine-version>")
// In the plugin target's dependencies:
.product(name: "WebViewNativeUIEngine", package: "engine")
```

For the plugin's Android Gradle configuration:

```groovy
dependencies {
    implementation 'io.github.webview-native-ui:engine:<engine-version>'
}
```

Keep `google()` and `mavenCentral()` in the consuming build's dependency repositories.

## iOS

In a Cordova SwiftPM plugin, declare both Cordova and Engine as dependencies of the plugin target; neither framework becomes a dependency of the Engine target. Keep the plugin's existing SwiftPM product and source-file declarations.

In the iOS platform section of `plugin.xml`, register the plugin for startup if its renderer should appear before the first application call:

```xml
<platform name="ios" package="swift">
    <config-file target="config.xml" parent="/*">
        <feature name="ExamplePlugin">
            <param name="ios-package" value="ExamplePlugin" />
            <param name="onload" value="true" />
        </feature>
    </config-file>
    <!-- Keep the plugin's existing source-file declarations. -->
</platform>
```

Merge these entries into the existing platform sections rather than adding duplicate sections. The [integration fixture](https://github.com/webview-native-ui/engine/tree/main/tests/cordova/plugin) includes complete plugin.xml, SwiftPM and Gradle wiring.

The examples extend an existing renderer: `nativeView` is its attached, positioned view, not a view created by the Engine.

```swift
import Cordova
import WebKit
import WebViewNativeUIEngine

@objc(ExamplePlugin)
class ExamplePlugin: CDVPlugin {
    private var projection: NativeUIProjection?
    private var nativeView: UIView?

    override func pluginInitialize() {
        // Existing renderer creates, attaches and positions nativeView here.
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

If the iOS renderer loads later, create the registration after its view is attached, and destroy the old registration before replacing the renderer.

Forward the plugin's existing presentation/content notifications with `projection?.receive("shown")`, `receive("hidden")` or `receive("contentChanged")`. Put this alongside the existing callback/event delivery, or in the plugin's shared notification method. `receive` updates the Engine session only: it does not deliver a second application callback. A matching destination emitted before JS startup is retained for the initial connection.

Cordova iOS's built-in `WkWebView.convertFilePath` serves the prepared PNGs. Engine resolves this internally. No file plugin, additional permission or author-provided URL converter is required. The default allowed origins include `app://localhost`; pass the actual trusted origin if the app changes its scheme or hostname.

## Android

Declare the Maven dependency in the existing Cordova plugin Gradle configuration. Also declare `implementation 'androidx.webkit:webkit:1.14.0'` when using the `CordovaPluginPathHandler` signature; Cordova's internal WebKit dependency is not exposed on the plugin compile classpath. In the Android platform section of the plugin's `plugin.xml`, merge this registration so initialization runs before the first WebView navigation:

```xml
<platform name="android">
    <config-file target="res/xml/config.xml" parent="/*">
        <feature name="ExamplePlugin">
            <param name="android-package" value="com.example.ExamplePlugin" />
            <param name="onload" value="true" />
        </feature>
    </config-file>
    <!-- Keep existing source-file and Gradle framework declarations. -->
</platform>
```

```kotlin
import android.view.View
import android.webkit.WebView
import io.github.webview_native_ui.engine.NativeUIProjection
import org.apache.cordova.CordovaPlugin
import org.apache.cordova.CordovaPluginPathHandler

class ExamplePlugin : CordovaPlugin() {
    private var projection: NativeUIProjection? = null
    private var nativeView: View? = null

    override fun pluginInitialize() {
        val web = webView.view as WebView
        projection = runCatching {
            // One origin-restricted channel per WebView, shared with later registrations.
            NativeUIProjection.install(web)
            // Existing renderer creates, attaches and positions nativeView here.
            NativeUIProjection(
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
        }.onFailure {
            android.util.Log.e(javaClass.simpleName, "Native UI projection unavailable", it)
        }.getOrNull()
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

Use `projection?.receive(eventName, data)` at the existing notification point, as on iOS. Native view creation and placement remain on the UI thread. If the renderer loads asynchronously, keep `install(web)` in `pluginInitialize()` and create the registration after the view is ready. Close the old registration before replacing that renderer.

The `PathHandler` delegates same-origin image requests to Engine. It serves only the registration's PNG files in app-private cache storage; unrelated paths return `null`. If the plugin already has a handler, combine them with `projection?.handleResource(path) ?: existingHandler.handle(path)`. For multiple registrations, delegate to the matching owner. Keep the handler installed for the WebView lifetime. No WebViewClient replacement or storage permission is needed.

The defaults support Cordova's `https://localhost` and `http://localhost`. If the hostname changes, pass the same explicit origin set to `install` and each registration. Wildcard origins and `file://` app origins are not supported by this integration.

## Lifetime and verification

Keep the registration for the WebView lifetime. Engine reconnects after a document reload and clears the old document's image state. If the plugin destroys its native UI in `onReset`, update its view provider and emit the appropriate destination; do not leave a registration pointing at a destroyed view. Dispose registrations when the plugin/WebView is destroyed.

Capacitor registrations retain their existing default. The Cordova integration requires the standard Cordova WebView resource handler. Running a Cordova plugin inside a Capacitor app is not covered by this integration; the host must use the Capacitor integration instead. See the shared [DOM and native surface requirements](projection.md#dom-and-native-surface-requirements) for selector, layout and capture rules. [Ionic overlay support](ionic-overlays.md) remains optional; plain Cordova apps need not enable it.

The integration fixture uses Cordova CLI 13, cordova-ios 8.1.1 and cordova-android 15.1.0 with their standard WebViews. It checks actual PNG handoff, native restoration and hidden-state retention across document reload, not merely JS bridge mocks. Older Cordova releases and custom WebView engines require separate verification.

Run the real consumer checks with an already booted simulator/emulator:

```sh
npm run test:cordova -- ios SIMULATOR_UDID
npm run test:cordova -- android emulator-5554
```

The script creates a disposable app, uses local SwiftPM/Maven Engine artifacts, and records the application result in the printed temporary directory. It never publishes to npm or Maven. Android requires JDK 21+, SDK 36 and `ANDROID_HOME`; iOS requires Xcode.

## Animated native controls

Native appearance updates prepare replacement images after a 50 ms debounce by default.
If your control continues animating after its update notification, set `captureDelayMs`
on the native registration (Swift: `captureDelayMs: 600`; Kotlin: `captureDelayMs = 600`).
This changes background image preparation, not overlay presentation timing.
See [capture timing](projection.md#capture-timing) for the cache behavior and measured guidance.

## Integrating with DOM inspection

The engine keeps a reusable image inside the fallback container, using its open ShadowRoot when available. No placement option is needed. If the renderer inspects child elements, exclude nodes marked `data-native-ui-projection-node`. See [DOM requirements](projection.md#dom-and-native-surface-requirements).
