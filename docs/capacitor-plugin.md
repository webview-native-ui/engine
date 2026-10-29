# Capacitor plugin integration

Add Web projection and restoration to an existing Capacitor plugin without changing its public `registerPlugin()` export. The plugin keeps its native renderer and application API; the Engine coordinates its native view with a DOM fallback.

This guide covers dependencies, registration, notifications and teardown. Use the [projection reference](projection.md) for exact contracts and platform limits.

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

This package declares support for Capacitor 8 (`>=8.0.0 <9`). The Engine library requires iOS 15+ and Android API 23+; the consuming Capacitor version or SDK may require a higher minimum. Composited Android capture requires API 26+ and the WebView features described in the [projection reference](projection.md#dom-and-native-surface-requirements).

## Choose the Web destination

Provide one laid-out DOM container for each registration, in the layer where its Web projection belongs. It may be inserted after registration. The plugin still owns native view placement and sizing; the Engine does not create or size either view for you.

Choose a [supported container](projection-containers.md) before wiring its selector. Read the [DOM and native surface requirements](projection.md#dom-and-native-surface-requirements) before integrating custom elements, SDK content or multiple surfaces. Scroll tracking and image handoff are internal to the registration. For Ionic applications, optionally enable [Ionic overlay support](ionic-overlays.md) once during application startup. Other frameworks emit the configured projection notifications from their own transition and overlay lifecycle.

## Install inside a plugin

Replace `<engine-version>` in every dependency below with the same published
release. Read that release tag’s documentation so the examples match its APIs.

```sh
npm install --save-exact '@webview-native-ui/engine@<engine-version>'
```

The npm archive contains TypeScript declarations, ESM, Swift sources and a podspec. Native dependencies must also be declared by the consuming plugin; an npm dependency alone links neither the Swift library nor the Android AAR.

The primary native distribution is Swift Package Manager. Depend on the repository-root library from your plugin:

```swift
.package(url: "https://github.com/webview-native-ui/engine.git", exact: "<engine-version>")
// In the plugin target's dependencies:
.product(name: "WebViewNativeUIEngine", package: "engine")
```

While the API is pre-1.0, pin the same Engine release across npm, SwiftPM, Gradle and CocoaPods, and upgrade deliberately. Applications should retain their dependency lockfiles for reproducible builds.

SwiftPM resolves this repository's version tags such as `v0.0.1`. For unreleased integration tests, use a local checkout or an explicit tested commit.

`import WebViewNativeUIEngine` requires no Capacitor registration. The npm companion supplies DOM measurement and Web image handoff; SwiftPM resolves the native dependency independently of npm hoisting.

### Android: add the Maven dependency

In the consuming plugin's `android/build.gradle`, add the Engine version matching its npm dependency:

```groovy
dependencies {
    implementation 'io.github.webview-native-ui:engine:<engine-version>'
}
```

Ensure `google()` and `mavenCentral()` are present in the consuming build's dependency repositories. For a build using centralized repositories, merge them into `android/settings.gradle`:

```groovy
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
```

If the build uses project-level repositories instead, add them to its existing `repositories` block. Installing the npm package does not add this Gradle dependency. Use a version whose POM and AAR are available from Central; `PUBLISHING` only confirms acceptance and does not yet guarantee downloads.

### CocoaPods compatibility through npm

CocoaPods uses the Swift sources and podspec shipped in npm; no CocoaPods Trunk publication is required. The plugin maintainer declares the matching dependency in the plugin's podspec:

```ruby
s.dependency 'WebViewNativeUIEngine', '<engine-version>'
```

The maintainer must also document this one-time application setup. Install the matching engine version as a direct npm dependency, then add the local pod **inside the application's target, outside `def capacitor_pods`**, which Capacitor regenerates:

```sh
npm install --save-exact '@webview-native-ui/engine@<engine-version>'
```

```ruby
# ios/App/Podfile; adjust the path for a different native project layout.
target 'App' do
  capacitor_pods
  pod 'WebViewNativeUIEngine', :path => '../../node_modules/@webview-native-ui/engine'
end
```

Run `npx cap sync ios` and rebuild. Keep the direct engine version aligned with the consuming plugin's dependency when upgrading. With a nonstandard node_modules layout, point `:path` at the installed engine package directory. An npm dependency alone does not register a Pod, and a podspec dependency cannot specify this local path. The engine intentionally has no Capacitor plugin registration or Podfile rewriting hook. SwiftPM consumers do not need this CocoaPods setup.

## Register from the native plugin

Keep the plugin's normal `registerPlugin()` export and public methods unchanged. Create and retain a registration after creating the native renderer. The engine ships its Web runtime with the Swift/Android library, starts it in the current document and future documents, finds the existing fallback DOM, and subscribes to the plugin's notifications. Applications do not call a separate JS initializer.

The integration has three responsibilities:

1. The consumer provides an existing, laid-out Web fallback container in the correct layer. Pass this projection destination as the required `projectionSelector: string`; there is no `null` / automatic DOM creation mode.
2. The plugin registers its native views and notification names once on each platform.
3. The plugin emits notifications after its updates and releases the registration at teardown.

### iOS: add the registration to your `CAPPlugin` class

In `ios/Sources/ExamplePlugin/ExamplePlugin.swift`, retain the registration as a property and initialize it in `load()`, **after your existing renderer creates and attaches its view**.

In this diff, `nativeView` is the `UIView` your plugin already owns; its existing rendering code is represented by comments.

Use the existing **`jsName`**, not `identifier`: Capacitor uses `jsName` for JS plugin calls and event subscriptions. Do not repeat the plugin name in the Engine configuration.

```diff
 import Capacitor
 import UIKit
+import WebViewNativeUIEngine

 @objc(ExamplePlugin)
 public class ExamplePlugin: CAPPlugin, CAPBridgedPlugin {
     public let identifier = "ExamplePlugin"
     public let jsName = "Example"
     public let pluginMethods: [CAPPluginMethod] = [
         CAPPluginMethod(name: "setColors", returnType: CAPPluginReturnPromise)
     ]
     private var nativeView: UIView?
+    private var projection: NativeUIProjection?

     public override func load() {
         // Existing code creates and attaches nativeView here.
+        do {
+            projection = try NativeUIProjection(
+                webView: bridge?.webView,
+                plugin: jsName,
+                projectionSelector: "#native-ui-fallback",
+                receiveListeners: .init(
+                    update: ["appearanceChanged"],
+                    projection: .init(
+                        native: ["shown"],
+                        web: ["transitionStarted"],
+                        none: ["hidden"]
+                    )
+                ),
+                view: { [weak self] in
+                    self?.nativeView
+                }
+            )
+        } catch {
+            CAPLog.print("Native UI projection unavailable: \(error)")
+        }
     }

     @objc func setColors(_ call: CAPPluginCall) {
         DispatchQueue.main.async {
             // Existing code applies the requested colors to nativeView.
+            self.notifyListeners("appearanceChanged", data: [:])
             call.resolve()
         }
     }
+
+    public override func notifyListeners(_ eventName: String, data: [String: Any]?, retainUntilConsumed: Bool) {
+        projection?.receive(eventName, data: data)
+        super.notifyListeners(eventName, data: data, retainUntilConsumed: retainUntilConsumed)
+    }
+
+    deinit {
+        projection?.destroy()
+    }
 }
```

Pass `bridge?.webView` directly. If the WebView is unavailable, the Engine throws an initialization error into the same `catch`; a separate guard or force unwrap is unnecessary.

If the view is created later in an existing `initialize` / `show` method, put the registration there after view creation instead of in `load()`. Retain one registration for that renderer's lifetime; do not create another on every update. When replacing a renderer, destroy its old registration before registering the replacement.

### Android: add the registration to your `Plugin` class

Make the corresponding changes in `android/src/main/java/<your-package>/ExamplePlugin.kt`. **`pluginHandle.id`** is Capacitor's registered plugin name, derived from `@CapacitorPlugin`; no second name string is needed.

```diff
 import android.view.View
 import com.getcapacitor.Plugin
 import com.getcapacitor.PluginCall
 import com.getcapacitor.PluginMethod
 import com.getcapacitor.annotation.CapacitorPlugin
+import android.util.Log
+import com.getcapacitor.JSObject
+import io.github.webview_native_ui.engine.NativeUIProjection
+import io.github.webview_native_ui.engine.NativeUIProjection.ReceiveListeners

 @CapacitorPlugin(name = "Example")
 class ExamplePlugin : Plugin() {
     private var nativeView: View? = null
+    private var projection: NativeUIProjection? = null

     override fun load() {
         // Existing code creates and attaches nativeView here.
+        projection = runCatching {
+            NativeUIProjection.install(bridge.webView)
+            NativeUIProjection(
+                window = activity.window,
+                webView = bridge.webView,
+                plugin = pluginHandle.id,
+                projectionSelector = "#native-ui-fallback",
+                receiveListeners = ReceiveListeners(
+                    update = listOf("appearanceChanged"),
+                    projection = ReceiveListeners.Projection(
+                        native = listOf("shown"),
+                        web = listOf("transitionStarted"),
+                        none = listOf("hidden")
+                    )
+                ),
+                view = { nativeView }
+            )
+        }.onFailure {
+            Log.e(javaClass.simpleName, "Native UI projection unavailable", it)
+        }.getOrNull()
     }

     @PluginMethod
     fun setColors(call: PluginCall) {
         activity.runOnUiThread {
             // Existing code applies the requested colors to nativeView.
+            notifyListeners("appearanceChanged", JSObject())
             call.resolve()
         }
     }
+
+    override fun notifyListeners(eventName: String, data: JSObject, retainUntilConsumed: Boolean) {
+        projection?.receive(eventName, data)
+        super.notifyListeners(eventName, data, retainUntilConsumed)
+    }
+
+    override fun handleOnDestroy() {
+        projection?.close()
+        projection = null
+        super.handleOnDestroy()
+    }
 }
```

On Android, call `NativeUIProjection.install(bridge.webView)` in plugin `load()`,
before the first navigation, even when SDK views arrive later. Include installation
in the same error boundary as registration; if it fails, keep the existing Web
fallback and do not retry installation after navigation. Registrations then
share that main-frame, origin-restricted channel; they do not install new message
listeners into a loaded WebView. Installing the channel before navigation avoids a WebView native crash when
registering a view that loads asynchronously. The registration constructor can
install the channel only on an un-navigated WebView; late installation fails with
an actionable error instead of attempting unsafe injection. All registrations on
the same WebView must use the same allowed origins. Closing a registration removes
only its owner from the channel, so other registered views continue working. The shared channel
remains installed for the WebView lifetime; registrations must still be retained
and closed by their consuming plugin.

Both diffs add a private property, native registration, a notification override, an update notification and teardown. They add no Engine methods to `pluginMethods`, no public JS wrapper, and no application-side Engine initializer.

Keep your plugin's existing `registerPlugin()` export. Use the same event names in the registration and `notifyListeners`; if the plugin already emits a suitable event (such as `tabSelected`), list that event instead of emitting it twice.

### Notifications during startup

The notification override above lets the Engine retain the latest matching projection destination before the Web runtime subscribes. No separate state variable or initial-state callback is needed. Forward every notification to `super` as usual: the Engine records state without replaying notifications, updates, or user actions. Without a destination notification, it infers the initial destination from native view visibility. Registration must exist before the notifications it should observe.

If your plugin owns multiple registrations, pass the notification to each registration; `receiveListeners.match` selects the owning surface. Appearance updates do not change the destination. The renderer still owns native placement and visibility before connection.

With the default Web fallback, scrolling without a prepared image or native scroll binding keeps the Web fallback visible until the renderer confirms current native placement with its native-destination notification. An appearance update alone is not that confirmation. Consumers choosing native failure recovery must keep their own native geometry current.

### Which events to emit

All incoming event declarations belong to `receiveListeners`. Its `update` list refreshes the image, its `projection` lists select the destination, and its optional `match` filters notifications for the owning surface.

| Notification                            | Where to emit it in the existing plugin                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `appearanceChanged` (an `update` event) | After a successful native appearance update, such as `setColors`                      |
| `transitionStarted` (`web`)             | Before the fallback DOM starts moving or a Web layer covers the native view           |
| `shown` (`native`)                      | After the plugin's existing show operation, or when returning from the Web projection |
| `hidden` (`none`)                       | After the plugin's existing hide operation                                            |

The names in the examples are conventions you choose, not reserved Engine methods. An `update` event refreshes the prepared image without changing the requested destination. It does not call `setColors` again.

Emit `transitionStarted` before the DOM starts moving, `shown` when native projection is requested again, and `hidden` after the plugin's own hide operation. Native capture, URL conversion, image preparation, draw acknowledgement, image retirement and listener cleanup stay inside the engine. The engine never invokes the plugin's `show`, `hide`, selection or ad-loading methods. End the registration with `projection.destroy()` on iOS or `projection.close()` on Android when the renderer is destroyed. Retain the registration for its full lifetime and call native APIs on the UI thread.

## Animated native controls

Native appearance updates prepare replacement images after a 50 ms debounce by default.
If your control continues animating after its update notification, set `captureDelayMs`
on the native registration (Swift: `captureDelayMs: 600`; Kotlin: `captureDelayMs = 600`).
This changes background image preparation, not overlay presentation timing.
See [capture timing](projection.md#capture-timing) for the cache behavior and measured guidance.

## Integrating with DOM inspection

The engine keeps a reusable image inside the fallback container, using its open ShadowRoot when available. No placement option is needed. If the renderer inspects child elements, exclude nodes marked `data-native-ui-projection-node`. See [DOM requirements](projection.md#dom-and-native-surface-requirements).

## Verify the integration

Show the control, change its appearance, then open and dismiss a covering Web
overlay. Check that the prepared appearance belongs to the current control and
that native interaction returns at the current position. Also check hiding,
container replacement and plugin teardown: late replies must not reveal retired
content. Exercise a missing image to verify the chosen Web fallback.

Use the actual control and backgrounds on supported devices; bridge success alone
cannot verify visual continuity. For a renderer that already batches controls by
page, continue with the [renderer guide](renderer-guide.md) rather than duplicating
registration machinery for each handoff.
