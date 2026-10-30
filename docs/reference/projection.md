# Projection reference

Use this reference to check integration contracts and platform limits. Start with
[concepts and integration choices](../concepts.md) to decide whether the Engine fits
your UI. Use [native initialization](../getting-started/initialization.md) to distinguish required
inputs, optional settings and advanced APIs, then follow the [Capacitor](../getting-started/capacitor.md),
[Cordova](../getting-started/cordova.md) or [renderer](../advanced/renderer.md) guide.

This page covers DOM lifetime, destination precedence, host requirements and native
eligibility. See [platform limits](platforms.md) for capture details, [projection state](state.md)
for the intent attribute, and [container support](containers.md) for HTML/Ionic hosts.

Use this contract when deciding what must survive a transition. For example, a
modal closes while a native restore reply is still in flight, and the framework
replaces the page DOM. The old reply must not reveal the departed page's controls;
the lifetime and destination rules below define that boundary.

## DOM and page lifetime

Native registration is independent of the JavaScript framework. Its selector identifies
one fallback container in the current document; it may appear after registration.
When a framework removes or replaces that container, the Engine retires the old
projection and binds the current matching element. A pending drag or native draw
acknowledgement from the departed container must not hold up its replacement.
Moving the same element between parents refreshes its scroll bindings without
requiring the plugin to register it again.

A full HTML navigation creates a new document and runtime session. The native
registration installs the runtime in the new document and retains the plugin's
explicit projection destination; images and replies belong to their original
document. Keep registrations for the native renderer's lifetime, rather than
recreating them for each framework page event.

These rules apply to selector-based native registration. A lower-level
`createWebProjectionScope(element)` intentionally binds that particular element;
its renderer remains responsible for replacing the scope when it changes elements.

The Engine cannot infer every framework's transition or modal semantics from DOM
mutations. Use the existing projection notifications for those transitions, and an
explicit overlay integration when needed. Ionic support is opt-in; it is not required
for ordinary DOM lifetime handling. Framework-specific events are not installed
automatically. Native view creation, layout constraints and SDK
lifecycle remain owned by the plugin.

## Projection contract

A notification specifies **where the surface belongs**, not how to capture it. The Engine chooses the platform-specific handoff without requiring the plugin to keep another copy of projection state.

| Intended destination | Required behavior                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `native`             | Show the interactive native view at confirmed geometry. During motion, use supported native tracking or a prepared image.              |
| `web`                | Keep native content below the covering Web layer by removing its native projection; use a prepared image or the plugin's Web fallback. |
| `none`               | Retire native content, projected images and fallback content. Later update/capture callbacks must not show it again.                   |

Overlay coverage can temporarily turn `native` into `web`; it never overrides `none`. A capture failure does not change the intended destination. `failedFallback: native` is only valid for consumers that maintain native placement themselves, and never overrides explicit `web`, `none`, or overlay coverage.

The Engine owns image readiness and restoration acknowledgement. It must not hide native pixels before replacement pixels are ready, nor retire replacement pixels before native restoration succeeds. Position-only motion reuses prepared content; appearance, size and renderer identity changes invalidate it. A missing image uses the declared fallback immediately rather than waiting to capture during a transition.

Registration and notification forwarding retain the latest intent across startup and reconnection; they do not replay business events. Destruction retires the registration and its cached images. Notifications are intent, not completion promises: an API that promises completed hiding must await the explicit retirement acknowledgement described under DOM and native surface requirements.

An existing renderer that checks CSS visibility can call `getUnprojectedVisibility(element)` from the npm package. It reads current authored/inherited visibility without the Engine's hiding rules, and restores projection ownership before returning. Do not use Engine marker attributes to infer projection ownership or mutate them in a consuming plugin. See [renderer DOM integration](../advanced/web-projection.md) for excluding Engine-owned mutations from renderer invalidation. This helper performs a style read and can trigger attribute observers; it does not eliminate measurement or transport costs.

## DOM and native surface requirements

`projectionSelector` is required and must resolve to **one existing container when projection starts**, using a valid CSS selector. ID, class, attribute and descendant selectors are supported; zero or multiple matches leave Native hidden. The engine does not create the fallback container or choose its size, placement, layer or z-index. Keep the container's normal layout and any interactive Web controls; an empty zero-size placeholder is not a usable fallback. It is a fixed scope, not a discovery root.

The container does not have to exist at registration time. A missing DOM waits without showing native content; replacing it creates a new binding and retires old images. The engine preserves the container's children, listeners and values. Pass the native view itself through `view`; a group of controls can use their common native container. The engine manages the internal identifier, so no ID list or view dictionary is required. Independent surfaces use separate registrations.

A Web Component host can be the destination, for example `projectionSelector: 'native-ad[placement="home"]'`. Give the host a layout box (`display: block` with the intended dimensions); the engine observes insertion, removal and selector attribute changes. The selector runs in the document and does not search inside shadow roots. The engine suppresses fallback content and pseudo-elements in the light DOM and open shadow roots during projection. Closed shadow content cannot be inspected and must inherit the host's `visibility`; provide a container whose shadow/slot structure can display the inserted image.

See [Projection container support](containers.md) for the HTML and complete Ionic element tables, sizing conditions and a wrapper example.

### Native surface requirements

When a plugin displays several independently moving native views—for example,
several advertisements in a scrolling feed—create a separate registration for
each view and give each one a selector matching its own DOM container. This lets
one view move, hide or be replaced without changing another view's projection.

If those registrations share plugin notifications, use `receiveListeners.match`
to route each notification to its intended registration. The matching fields are
chosen by your plugin, not reserved Engine identifiers. For example, include
`viewKey` to identify the displayed item and `instanceId` to distinguish successive
loaded instances for that item:

```swift
match: ["viewKey": viewKey, "instanceId": instanceId]
```

```kotlin
match = mapOf("viewKey" to viewKey, "instanceId" to instanceId)
```

Include the same fields in the notification payload. Dispose the old registration
when replacing its loaded content, even if the native container is reused, so
notifications for the previous instance cannot affect the replacement.

For third-party SDK views, keep loading and interaction handling in your plugin.
Use `canCapture` to report whether the current content may be captured under the
SDK's rules and your integration's supported capture conditions. For example, an
advertising SDK may require different handling for video and static content.
The Engine does not grant permission to capture SDK content or replace its
click and impression handling.

For SDK consumers without an equivalent Web fallback, set `failedFallback: .native`
on iOS or `failedFallback = NativeUIProjection.FailedFallback.NATIVE` on Android.
The default is `.web` / `WEB`, preserving existing consumers. If automatic motion
cannot use a prepared image (not ready, unsupported capture, or rejected handoff),
`native` preserves the live native view and keeps fallback DOM hidden. The consumer
must continue positioning that view; this option does not create native scroll
tracking on Android. Explicit `web`, `none`, and overlay coverage take precedence:
this option never raises a native view above an intentionally covering Web layer.

On Android, consumers whose asynchronous hide method promises that all pixels have
disappeared must call `projection.hide { completed -> ... }` and resolve only when
`completed` is true. Native handoff copies disappear immediately; completion waits
for synchronous Web-proxy retirement. A timeout reports failure, not success.
Call `projection.show()` when presenting again, in addition to normal plugin events;
this also preserves presentation intent if event subscription is still starting.

Scroll observation follows composed-tree ancestors, including assigned slots.
Non-composed scroll events inside an Ionic shadow tree are observed at their source;
applications do not add an extra listener or dispatch synthetic document events.
Listeners follow host reparenting and slot reassignment and are removed on teardown.

Scrolling is internal: iOS uses a uniquely matched native scroll binding when available; otherwise, including Android, scrolling temporarily uses the prepared image and restores native content after motion settles. Automatic scroll handling never overrides explicit `web` or `none`. Unsupported capture or geometry keeps the normal DOM fallback; it does not wait for a new capture on the transition path. The latest explicit destination survives WebView reload, and old-document replies cannot complete a new document's requests.

The internal channel is limited to the main frame. Capacitor origins come from the bundled `capacitor.config.json`: `server.url` takes precedence over the local hostname/scheme. To override them, pass exact `allowedOrigins` (on Android, to `install` before navigation; registrations inherit them). Neither `allowNavigation` nor the current WebView URL expands this set. Android requires WebView's `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT` features; registration fails explicitly on unsupported WebView implementations. Do not use wildcard origins for remotely navigable WebViews.

For capture modes, translucent surfaces, image color and private storage, see
[capture and platform limits](platforms.md). Custom renderer bridge and scroll
bindings are documented under [native handoff](../advanced/native-handoff.md).

[Documentation overview](../README.md)
