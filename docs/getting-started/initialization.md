# Initialize a native view registration

Start with `NativeUIProjection` when a plugin owns a native view and a corresponding
Web container. Registration starts the runtime, binds that container and coordinates
image handoff and restoration. You do not need the renderer APIs for this route.

Use the [Capacitor](capacitor.md) or [Cordova](cordova.md) guide for
dependency installation, plugin lifecycle hooks and notification forwarding.
The examples below show the smallest registration within those hooks, followed by
required inputs. After initialization, the configuration guide lists optional
behavior; advanced APIs have their own entry point.

For example, a plugin already draws a native tab bar, but an application opens a
Web settings sheet above it. Register the bar and its fallback navigation host so
the Engine can put the captured bar beneath that sheet and restore native input
when it closes. The plugin keeps its existing tab selection API.

## Minimal initialization

Create and retain one registration after your renderer has attached its native
view. The selector may match a DOM container added later, but native presentation
waits until that container exists. Give it a [supported layout box](../reference/containers.md).

In a Capacitor Swift plugin, inside `load()` or the existing renderer initializer:

```swift
projection = try NativeUIProjection(
    webView: bridge?.webView,
    plugin: jsName,
    projectionSelector: "#native-ui-fallback",
    view: { [weak self] in self?.nativeView }
)
```

In a Capacitor Kotlin plugin, install the shared channel in `load()` **before the
first WebView navigation**. The registration may be created later when its view is ready:

```kotlin
NativeUIProjection.install(bridge.webView)
projection = NativeUIProjection(
    window = activity.window,
    webView = bridge.webView,
    plugin = pluginHandle.id,
    projectionSelector = "#native-ui-fallback",
    view = { nativeView }
)
```

Both snippets belong inside the integration guide's error boundary; retain the
existing Web fallback if initialization fails. `projection` and `nativeView` are
properties of your plugin. Dispose the registration with `destroy()` on iOS or
`close()` on Android when that renderer is retired. All native lifecycle calls
run on the UI thread.

Cordova uses the same registration with `runtime: .cordova` / `runtime = Runtime.CORDOVA`
and its own WebView and plugin identity. Follow the [Cordova guide](cordova.md)
for those hooks and Android's resource handler.

## Required inputs

| Input                | Platforms     | What it identifies and why                                                                                                                                                                                                                                         |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webView`            | iOS / Android | The application's WebView, which owns the destination document and bridge. Swift accepts an optional reference so a missing WebView throws through the initialization error boundary.                                                                              |
| `plugin`             | iOS / Android | The existing plugin identity routes notifications to this plugin rather than another Engine consumer. Capacitor: `jsName` on iOS, `pluginHandle.id` on Android. Cordova: the configured service name.                                                              |
| `projectionSelector` | iOS / Android | A CSS selector matching exactly one existing Web container when presentation begins. It gives the image its correct layout and overlay layer; a native rectangle cannot identify that DOM layer.                                                                   |
| `view`               | iOS / Android | A callback returning the renderer's current native view, or nil/null when absent. Return the current view within this renderer lifetime. When replacing the renderer, dispose its registration and create a new one; the plugin owns layout and normal visibility. |
| `window`             | Android       | The window containing the WebView and native surface, needed for composited capture and interaction tracking.                                                                                                                                                      |

These inputs establish ownership. They do not tell the Engine when content
changes or when an application transition should change presentation.

## Next: configure changing UI

The minimal registration establishes ownership. Continue with [optional settings](../configuration/README.md)
for event wiring, value reflection, capture and failure policy. Each setting lists
its default and when it is needed. See [advanced APIs](../advanced/README.md) only when
your renderer already manages batches, placement or update reconciliation.

[Documentation overview](../README.md)
