# Projection reference

Use this reference to check integration contracts and platform limits. Start with
[concepts and integration choices](concepts.md) to decide whether the Engine fits
your UI, then follow the [Capacitor](capacitor-plugin.md),
[Cordova](cordova-plugin.md) or [renderer](renderer-guide.md) guide.

| Question                                                | Reference                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| What survives DOM replacement or page navigation?       | [DOM and page lifetime](#dom-and-page-lifetime)                                            |
| When can native content or its image be shown?          | [Projection contract](#projection-contract)                                                |
| Which DOM hosts and native views are eligible?          | [DOM and native surface requirements](#dom-and-native-surface-requirements)                |
| How does a custom renderer implement the bridge?        | [Native handoff](#native-handoff-on-both-platforms)                                        |
| Where do images live, and which permissions are needed? | [Temporary storage](#temporary-storage-and-application-permissions)                        |
| What movement can remain native?                        | [Native scroll tracking](#native-scroll-tracking)                                          |
| What differs on Android?                                | [Android library](#android-library)                                                        |
| When is an image captured, and how accurate is it?      | [Capture timing](#capture-timing) and [iOS color precision](#image-color-precision-on-ios) |

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

An existing renderer that checks CSS visibility can call `getUnprojectedVisibility(element)` from the npm package. It reads current authored/inherited visibility without the Engine's hiding rules, and restores projection ownership before returning. Do not use Engine marker attributes to infer projection ownership or mutate them in a consuming plugin. See [renderer DOM integration](renderer-guide.md#low-level-web-projection) for excluding Engine-owned mutations from renderer invalidation. This helper performs a style read and can trigger attribute observers; it does not eliminate measurement or transport costs.

## DOM and native surface requirements

`projectionSelector` is required and must resolve to **one existing container when projection starts**, using a valid CSS selector. ID, class, attribute and descendant selectors are supported; zero or multiple matches leave Native hidden. The engine does not create the fallback container or choose its size, placement, layer or z-index. Keep the container's normal layout and any interactive Web controls; an empty zero-size placeholder is not a usable fallback. It is a fixed scope, not a discovery root.

The container does not have to exist at registration time. A missing DOM waits without showing native content; replacing it creates a new binding and retires old images. The engine preserves the container's children, listeners and values. Pass the native view itself through `view`; a group of controls can use their common native container. The engine manages the internal identifier, so no ID list or view dictionary is required. Independent surfaces use separate registrations.

A Web Component host can be the destination, for example `projectionSelector: 'native-ad[placement="home"]'`. Give the host a layout box (`display: block` with the intended dimensions); the engine observes insertion, removal and selector attribute changes. The selector runs in the document and does not search inside shadow roots. The engine suppresses fallback content and pseudo-elements in the light DOM and open shadow roots during projection. Closed shadow content cannot be inspected and must inherit the host's `visibility`; provide a container whose shadow/slot structure can display the inserted image.

See [Projection container support](projection-containers.md) for the HTML and complete Ionic element tables, sizing conditions and a wrapper example.

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

For opaque, software-renderable Android SDK views, use
`captureMode = NativeUIProjection.CaptureMode.VIEW` together with an explicit
`failedFallback` policy (`WEB` unless the consumer maintains native placement). This draws only the View's
pixels with no surrounding padding, so clipping a partially visible ad cannot bake
in a toolbar or adjacent content. Video, SurfaceView, translucent views, and content
requiring Window composition must keep the default `COMPOSITED` mode. The consumer
must provide a matching, clipped DOM host for the full opaque View; arbitrary native
outline masks, transforms, and custom clipping are not reproduced.

VIEW pixels are cached by native View identity, dimensions, and content revision.
Ordinary scrolling retains the decoded Web image and updates placement without
capture, PNG encoding, or image decode. The image covers the host border box at
local origin (0, 0), independently of native placement acknowledgment latency.
Opaque images remain painted beneath the live native View between scrolls.
Before hiding that View, the engine waits for WebView visual readiness and a draw;
VIEW creates no native entry or return image copies. Return acknowledgment waits
across the native draw and the following animation frame. A generation check prevents
a delayed cover callback from hiding content after restoration or suspension.

The native Bitmap is recycled after PNG encoding in VIEW mode; the PNG and decoded
Web image remain cached. Plugin update notifications advance the content revision:
notify an update whenever content changes without replacing the View. Replacing the
registration, WebView navigation, reset, or close retires the cache. Encoding stays
off the UI thread; View drawing and cache ownership stay on it, with the existing
8-million-pixel cap.

COMPOSITED retains native handoff copies for translucent content. Entry copies wait
for WebView visual readiness and a draw before retirement. If the 500 ms entry
deadline expires, the native View is restored before the copy is removed, and a late
paint acknowledgment is rejected.

Android VIEW consumers can read `isProjecting` on the UI thread after a successful
cover to defer same-size native placement work. Keep only the latest accepted placement;
continue validating sequence/generation, and process hide, resize and teardown immediately.
Supply `beforeNativeReveal` to apply that pending placement synchronously before normal
restoration, failure recovery, or active-image release reveals native pixels. The engine
clears `isProjecting` before invoking the callback, so applying placement must not defer
again. The callback may run without pending work and must be idempotent. Clear consumer
pending work on hide/destroy and validate the loaded View identity before applying it.
The callback does not replace content/size invalidation or JavaScript geometry tracking.

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

By default, the internal channel is limited to the main frame on Capacitor's localhost origins. Pass the application's exact `allowedOrigins` for a different configured origin. Android requires WebView's `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT` features; registration fails explicitly on unsupported WebView implementations. Do not use wildcard origins for remotely navigable WebViews.

## Native handoff on both platforms

An existing renderer should forward its ordered `WebProjectionRequest` messages
to the native snapshot manager's `handle` method. This keeps request validation,
CSS-to-native coordinate conversion, cached image handoff and copy retirement in
the Engine. The bridge remains the plugin's own Capacitor or Cordova method; the
Engine does not depend on either framework's call object.

Call view and snapshot lifecycle APIs on the main/UI thread. Supply two renderer
callbacks: `frames(ids, revision)` returns current eligible bounds, and `views(ids)`
returns the complete native views that can safely be hidden together. Return empty
bounds or `nil` / `null` when that operation is unavailable. Bounds use **points
relative to the WebView on iOS** and **physical pixels relative to the WebView on
Android**. The Engine checks that measured IDs exactly match the request.

```swift
snapshots.handle(request, in: webView,
    frames: { ids, revision in renderer.measure(ids, at: revision) },
    views: { ids in renderer.viewsAllowedToHide(ids) },
    complete: reply)
```

```kotlin
snapshots.handle(request, activity.window, webView,
    frames = { ids, revision -> renderer.measure(ids, revision) },
    views = { ids -> renderer.viewsAllowedToHide(ids) },
    complete = { result ->
        result.fold(onSuccess = reply, onFailure = reject)
    })
```

`renderer` and `reply` above are the plugin's existing layout code and bridge
completion callback. On Android, forward a failed `Result` to the bridge's
rejection callback (`reject` above); Web uses that failure to abandon the image
and reconcile presentation. Do not acknowledge a failed drawing boundary as
success. `frames` may run repeatedly while geometry settles; it must
recheck the requested revision and capture eligibility. It must not mutate layout.
If multiple controls share a native container, `views` must reject a partial set
that would hide uncaptured controls. The Engine cannot infer that relationship.
The renderer also keeps its existing native interaction notifications.

`cover` installs prepared pixels before hiding those views. Destination parts are
validated against the cached token and used for both cover and restore, so moving
a prepared surface does not reuse an old position. Invalid or unavailable handoffs
return `shown: false`. `painted` and `restored` retire only the corresponding copy;
Android waits for Web drawing readiness. `release` and `reset` retire owned
resources. No capture starts in the cover or restore path.

The renderer still performs its ordinary native update between `restore` and the
accepted update acknowledgement. Before that update, call `restoreControls()` on
iOS or `restoreViews()` on Android to undo only the Engine's hiding changes. This
is not a command to lay out or reveal arbitrary plugin content. Keep the normal
visibility and placement policy in the renderer.

### Direct snapshot primitives

Use these only when your integration owns native placement during handoff. `NativeUIProjection` uses the same operations with registration-specific placement and opaque-view policies. Do not duplicate conversion or copy retirement when forwarding requests to `handle`.

- Convert destination `parts` from CSS pixels using `webView.bounds.width / viewportWidth` on iOS or `webView.width / viewportWidth` on Android. Pass frames to `cover` and `restore`; absent cover parts retain captured placement. Neither operation captures new pixels.
- `transient: true` separates a moving foreground surface from the background's `coveringToken`. Reuse pixels while source sizes and positions relative to their scope remain unchanged; movement within a fixed scope invalidates the layout.
- Retire the entry copy after Web drawing readiness: `retireCopy(token)` on iOS, `retireCopyAfterWebDraw` on Android.
- For return, call `restore`, undo Engine hiding with `restoreControls()` / `restoreViews()`, and apply normal native layout. Retire the return copy after the accepted native update and Web drawing readiness, using `retireCopy` with `entry: false` / `entry = false`. Android can forward `painted` and `restored` to `handle` to reuse readiness and rejection handling.
- Release tokens with `release(token)`. Use `reset()` only for owner teardown, and Android `close()` to dispose the encoder. Never reset another surface's captures.

Missing captures or placement use the renderer's ordinary fallback. See the [Web request contract](renderer-guide.md#multiple-fallbacks-in-one-native-transaction) for payloads.

Use `NativeUICoveredSnapshots.observe` to notify the JS listener when interaction starts/ends. On iOS, captures rasterize the visible window with `drawHierarchy(in:afterScreenUpdates:)`, including the background under the clipped native component. Screen snapshot views are display replicas and are not used as bitmap sources. UIKit rasterization can differ from the live compositor for materials such as Liquid Glass; validate the appearance on physical devices with the backgrounds your plugin supports. Cache validity therefore includes layout and the plugin's visual-change notifications. The engine does not capture continuously or guarantee every possible renderer can be captured.

## Temporary storage and application permissions

Prepared images stay in the app's private temporary storage. iOS uses `FileManager.default.temporaryDirectory`. On Android, construct `NativeUISnapshots` with a directory inside `context.cacheDir`; do not use shared or external storage. Neither platform needs a photo-library or storage permission prompt for this path. No Capacitor Filesystem plugin is required. See [Apple's sandbox directories](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html) and [Android's app-specific storage](https://developer.android.com/training/data-storage/app-specific).

`Capacitor.convertFileSrc` maps the returned file URL to the existing WebView local server. It grants no filesystem permission and does not upload the image. If the application sets a Content Security Policy, its `img-src` must allow the local app origin used by that URL; do not enable broad `file:` access or unrelated WebView file-access settings.

`release(token)` and owner teardown remove owned snapshot files. Abrupt process termination can leave temporary images until the operating system clears the cache or the app is uninstalled; immediate deletion after a crash is not guaranteed. Keep this storage private and treat it as disposable, not persistent application data.

## Native scroll tracking

`readScrollPlacement(element, owner, identify)` measures one untransformed overflow owner. `createScrollBindings()` validates reuse and detects movement while acquisition is awaiting ACK. Keep `reuse` out of layout-deduplication signatures; it describes acknowledgement state, not layout.

On iOS, `NativeUIScrollBindings.replace` groups sources by owner and binds only an unambiguous matching `UIScrollView`. `update()` applies positions and clipping without rebuilding content. `NativeUIClippedView` preserves full content dimensions while restricting visible pixels and hit testing.

An established binding rejected by native loses ownership and may be freshly acquired through the **same** update/ACK path. A failed fresh acquisition stays on the fallback until a relevant layout/scroll-end event. Never add an immediate retry loop or replay user actions. A frame/props change does not recalibrate an established coordinate origin.

This uses WKWebView's internal overflow hierarchy without private class names. Missing/ambiguous views, nested scrolling, document scrolling, unsupported transforms, shaped clipping, or a moving unconfirmed owner cannot be bound. Do not claim support solely because a `UIScrollView` exists. A native view may intercept gestures that begin inside it; routing those gestures and SDK accessibility behavior remain renderer-specific.

## Android library

Android uses a Gradle Android library, distributed as an AAR through Maven rather than Capacitor plugin registration. The publication coordinates are `io.github.webview-native-ui:engine:<version>`. Build and verify the local Maven publication with:

```sh
android/gradlew -p android testDebugUnitTest assembleRelease connectedDebugAndroidTest publishReleasePublicationToVerificationRepository
```

`NativeUIClippedView` is a low-level helper that applies caller-supplied position and clipping without resetting unchanged dimensions. `NativeUIProjection` manages image handoff and restoration; it does not use this helper to lay out the renderer. The consuming plugin owns normal native placement and size updates. Android does not claim WKWebView-style native overflow binding. High-level registrations share a non-consuming window touch observer: down cancels in-flight capture adoption, up/cancel/focus loss permits preparation again, and teardown removes only that registration. Existing callback dispatch and return values are preserved.

`NativeUISnapshots` prepares composited PixelCopy images and local PNG files, then covers/restores from that cache. Encoding runs off the UI thread; only one preparation runs per owner. Notify it of visual changes and interaction, and release tokens on teardown. All view/lifecycle calls run on the UI thread. The plugin retains revision, eligibility and fallback policy.

After prepared Web pixels are shown or retired, `NativeUIWebReadiness.prepare` checks readiness for a subsequent WebView draw. Its `current` predicate must validate the owning session, source generation and image revision. The temporary native copy covers this asynchronous handoff; overlay startup itself does not wait. Neither bridge acknowledgement nor this callback proves physical display presentation.

An opaque image can remain beneath an opaque native view between handoffs, but
that policy must not be applied to translucent controls: drawing a translucent
view over its own captured appearance would composite the content twice. Choose
capture behavior for the actual view and background, and validate the complete
integration. Never synthesize clicks through a projected image.

### Translucent Android surfaces

Capture the composited window pixels, including the background, instead of drawing the translucent view onto an empty bitmap. Keep the prepared Web image decoded but hidden. At handoff, `cover(token, window, reference, views)` installs a temporary opaque image copy before hiding those native views in the same UI turn. Reveal the Web image, confirm Web drawing readiness, then retire the entry copy. The overlay starts immediately; image encoding is never on this path.

For return, install the prepared return copy with `restore`, restore the native views underneath it, hide the Web image, and retire the return copy after Web drawing readiness. This avoids compositing live translucent native pixels over their own snapshot. Validate the token and current surface generation at every asynchronous callback. The temporary copy is noninteractive and bounded; teardown releases both copies and cached resources.

This preserves the captured background, not a continuously changing scene behind the image. Background changes must invalidate the cache through the same visual-change notifications as content updates. Video and unsupported capture surfaces retain the consumer's fallback policy.

Consumer integration tests belong to their respective repositories. Engine CI exercises its browser, Swift and Android contracts without requiring a sibling renderer checkout.

### Final placement when returning from an opaque image (Android)

A plugin that normally measures and posts native placement on every scroll can opt
into a final placement handoff. Pass `updatePlacement: (JSONObject) -> Unit` to its
Android `NativeUIProjection` registration and bind its Web host with
`bindProjectionPlacement(element, measure, invalidate)`.

- `binding.projected` becomes true only after native confirms the image handoff.
  While true, the plugin can reuse that host's last placement in full placement
  batches and skip measuring it. Other hosts continue their ordinary updates.
- `measure()` returns a JSON object synchronously. The engine includes it in the
  existing restore request (or an active-image recovery request). Native validates
  the active image token and View identity, calls `updatePlacement`, then reveals
  native and acknowledges its draw. No extra bridge round trip is introduced.
- The plugin must validate its own identity, generation and per-host sequence in
  `updatePlacement`. Throw to reject a stale or invalid placement. A final update
  for one host must not cause updates for another host to be dropped.
- `invalidate()` is called after a failed handoff request. Clear optimistic
  placement/deduplication caches and schedule ordinary placement reconciliation.
- Dispose the binding when detaching a host. Session ownership prevents an old
  registration's delayed acknowledgement from clearing a new registration's
  projection state. Pause, author visibility and layout changes must still use
  the plugin's normal visibility/invalidation paths.

This opt-in does not change registrations without `updatePlacement`. Android rejects
`updatePlacement` unless `captureMode = CaptureMode.VIEW`; live video and other ineligible captures
continue native placement tracking under `failedFallback = NATIVE`.

## Capture timing

`captureDelayMs` is an optional registration setting shared by Capacitor and Cordova.
It defaults to **50 milliseconds** on iOS, Android and the lower-level `createWebProjection`
options. Values must be finite and nonnegative. It uses the existing debounce: a new
update or interaction restarts preparation after activity settles. It does not add a
second timer or delay the overlay's presentation.

Until replacement pixels are ready, the last completed image remains available. If
there is no completed image, normal Web fallback applies. Opening an overlay during
the debounce does not wait for a new capture. Consequently, increasing the delay also
increases the period in which the previous appearance may be used after an update.

A starting recommendation for **UITabBar Liquid Glass selection animations is 600 ms**.
In iOS 27.0 iPhone and iOS 27.1 Duo simulator comparisons, 50 ms captured an enlarged
selection, 300 ms still retained a small residual change, and 600 ms matched the settled
appearance observed at 1000 ms. This is a recommendation for that interaction, not an
Apple timing contract or a universal Liquid Glass duration. Measure your control's
selection, reselection and successive updates before choosing a value. Continuously
changing content has no guaranteed settled snapshot.

## Image color precision on iOS

Prepared window snapshots use an extended Display P3 Float16 bitmap during capture
and are encoded as 16-bit Display P3 PNGs on a background queue. The Web projection
displays the prepared image directly, without a Canvas or WebGPU conversion. Native
entry and return copies also use the decoded PNG, so both sides share the same
prepared pixels after color conversion. Encoding and decoding
stay outside the overlay handoff; consumers do not need a new setting or dependency.

This reduces color loss in wide-gamut content but does not guarantee identical Liquid
Glass appearance: native compositing and conversion to integer PNG can still change
pixels. Higher precision also increases capture memory and image size. The existing
fallback policy applies if preparation fails. Android retains its platform capture path.
