# Projection behavior and advanced integration

Start with the [Capacitor](capacitor-plugin.md) or [Cordova](cordova-plugin.md) guide. This reference explains shared DOM requirements, destination rules and the lower-level APIs for existing renderers.

## Ownership

| Engine                                                              | Consuming plugin                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| DOM measurement, image geometry and supported native scroll binding | Creating, attaching, positioning and sizing native views             |
| Startup, event subscriptions and native draw acknowledgements       | Providing the fallback DOM at the correct layer                      |
| Prepared image cache, decoding, display and retirement              | Reporting appearance changes and the intended projection destination |
| Native capture and temporary return images                          | Providing native views and SDK capture eligibility                   |
| Image invalidation, token cleanup and observer teardown             | Owning business actions and the interactive Web fallback             |

A DOM slot does not necessarily contain a Web replacement: a UI plugin can restore a button, while an ad plugin may hide its slot. Image handoff is explicit and noninteractive. The engine never forwards clicks through an image or replaces SDK click/impression handling.

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

An existing renderer that checks CSS visibility can call `getUnprojectedVisibility(element)` from the npm package. It reads current authored/inherited visibility without the Engine's hiding rules, and restores projection ownership before returning. Do not use Engine marker attributes to infer projection ownership or mutate them in a consuming plugin. Excluding Engine-owned DOM mutations from renderer invalidation is described below. This helper performs a style read and can trigger attribute observers; it does not eliminate measurement or transport costs.

## DOM and native surface requirements

`projectionSelector` is required and must resolve to **one existing container when projection starts**, using a valid CSS selector. ID, class, attribute and descendant selectors are supported; zero or multiple matches leave Native hidden. The engine does not create the fallback container or choose its size, placement, layer or z-index. Keep the container's normal layout and any interactive Web controls; an empty zero-size placeholder is not a usable fallback. It is a fixed scope, not a discovery root.

The container does not have to exist at registration time. A missing DOM waits without showing native content; replacing it creates a new binding and retires old images. The engine preserves the container's children, listeners and values. Pass the native view itself through `view`; a group of controls can use their common native container. The engine manages the internal identifier, so no ID list or view dictionary is required. Independent surfaces use separate registrations.

A Web Component host can be the destination, for example `projectionSelector: 'native-ad[placement="home"]'`. Give the host a layout box (`display: block` with the intended dimensions); the engine observes insertion, removal and selector attribute changes. The selector runs in the document and does not search inside shadow roots. The engine suppresses fallback content and pseudo-elements in the light DOM and open shadow roots during projection. Closed shadow content cannot be inspected and must inherit the host's `visibility`; provide a container whose shadow/slot structure can display the inserted image.

### Supported destination elements

The selected element must have a layout box and be able to contain the projected image.

| Destination                                            | Support                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `div`, `section`, `nav`, `button`                      | Supported with the intended size and placement.                                                                         |
| `span`, `a`                                            | Use `inline-block` or `block` with the intended dimensions; avoid fragmented inline text.                               |
| `select`, `input`, `textarea`                          | Use an outer container; direct scopes are rejected.                                                                     |
| `img`, `canvas`, media/embedded content, void elements | Use an outer container; direct scopes are rejected.                                                                     |
| SVG/MathML                                             | Use an HTML container.                                                                                                  |
| Custom elements, including `ion-select`                | Conditional on their layout and Shadow DOM structure, as described above. An `ion-select` host is not an HTML `select`. |

For example, select `#seat-projection` as the destination:

```html
<span id="seat-projection" style="display: inline-block; width: 12rem; height: 2.75rem">
  <select aria-label="Seat" style="width: 100%; height: 100%">
    <option>Any seat</option>
  </select>
</span>
```

The existing control and its value/listeners are preserved. The image is noninteractive; the plugin still owns native control behavior and value synchronization. Pseudo-elements are not selectable destinations. Elements without a usable box (`display: none`, `display: contents`, zero size) and elements with special child-rendering rules such as `option` need an ordinary wrapper.

### Native surface requirements

For independently moving AdMob slots, retain one registration per loaded native view/surface, use a slot-specific selector and filter the plugin's notifications through `receiveListeners.match` (`match: ["slotKey": slotKey, "loadId": loadId]` / `match = mapOf("slotKey" to slotKey, "loadId" to loadId)`). Dispose the registration when a loaded ad is replaced, even if its host view is reused. Keep SDK loading, impression and click handling in the ad plugin. Supply `canCapture` with its existing capture eligibility checks (for example, test-ad / opaque-background / no-video restrictions); the engine does not grant permission to snapshot an SDK view.

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

## Ionic overlay support (optional)

For an Ionic application, call this once during application startup. When calling it directly from the application, install `@webview-native-ui/engine` as a direct application dependency:

```ts
import { enableSupportIonicOverlays } from '@webview-native-ui/engine/ionic';

enableSupportIonicOverlays();
```

Plugin maintainers can include this snippet in their application setup instructions, or call it inside an existing JS initializer. `@rdlabo/capacitor-native-ui` already calls the same initializer internally; its users need no additional call. Non-Ionic applications omit it. Native registration alone does not install Ionic event listeners.

One monitor is shared per document, including between the npm module and the runtime injected by Swift/Android. Repeated initialization does not add listeners or erase explicit configuration. Destroying one projection removes only its subscription; it does not stop the monitor used by other plugins. The monitor lives with the document.

The default covers Modal, Popover, Alert, Action Sheet, Loading, Picker, Toast and Menu lifecycle events. It compares each projection's DOM with the active overlay stack: content inside the front modal stays native, while covered content temporarily uses its prepared image. Toasts and inactive sheet backdrops do not cover a surface. Nested overlays keep it covered until the remaining stack permits restoration. Missing images retain the normal Web fallback. This temporary coverage never overwrites a plugin's explicit `web` or `none` destination. Projections registered later read the current state.

Native Popover ownership is supplied by the Native UI vertical-bars renderer. The shared monitor does not treat its source DOM as a covering Web overlay. If native presentation fails, the renderer releases ownership and normal DOM coverage resumes.

Optional settings are document-wide:

```ts
enableSupportIonicOverlays({
  exclude: '[data-nonblocking-overlay]',
  additional: [
    {
      selector: 'app-dialog',
      events: {
        willPresent: 'appDialogWillPresent',
        didDismiss: 'appDialogDidDismiss',
      },
    },
  ],
});
```

Use `covers(overlay, target)` only when a registered DOM projection needs a custom coverage rule; return `undefined` for the default, or a boolean to override it. Exclusions and explicit native-window ownership take precedence. The standard relationship uses overlay order, DOM containment and backdrop state, rather than attempting to interpret arbitrary CSS stacking contexts. Configure unusual layouts explicitly.

## Low-level Web projection

A scope binds one existing Web fallback element for its lifetime. Obtain that element from your plugin's DOM; the engine does not create a replacement host or choose a page, stacking order or z-index. A different fallback element requires a new scope. Its Document is derived from `element.ownerDocument`.

```ts
import { createWebProjectionScope, createWebProjection } from '@webview-native-ui/engine';

const fallback = container.querySelector<HTMLElement>('[data-web-fallback]');
if (!fallback) throw new Error('Web fallback is missing');
const scope = createWebProjectionScope(fallback, 'my-plugin');
const projection = await createWebProjection(
  scope,
  {
    send: (request) => plugin.snapshot(request),
    listen: (listener) => plugin.addListener('snapshotInteraction', listener),
  },
  {
    wake: () => schedulePluginUpdate(),
    blocked: () => overlayIsActive(),
    revision: () => lastSentRevision,
  },
);
```

The container, bridge and update callbacks above belong to the consuming plugin. No `document`, `target`, `layer`, CSS selector or layer resolver is passed to the projection manager.

1. After an accepted native update, call `projection.consider(revision, sources)`. Sources associate the native IDs and viewport frames with their source DOM; they need not be inside the fallback element. Images are captured and decoded in advance.
2. Call `projection.changed()` for appearance changes, or `projection.changed(scrollElement)` to invalidate scroll geometry. Layout updates go through `consider`; use `invalidate()` for other geometry changes.
3. Before covering Native with a Web overlay, call `projection.begin()`. It displays already prepared pixels at the fixed fallback. No new capture or decode starts here. If capture is unavailable, the plugin keeps its ordinary Web fallback.
4. Exclude `projection.owners` from normal Native updates while the image owns those sources. `visibleOwners` keeps their return pixels while Native is being restored; `preparedOwners` identifies sources with prepared images. These arrays are read-only snapshots.
5. Call `projection.end()`, send the normal native update, then call `projection.updated(snapshotToken, acceptedIDs, revision)`. A newer acknowledgement containing all captured IDs retires the image.
6. Call `projection.destroy()` when disposing the surface. It releases only its own images and listener; the plugin owns final Native reset and its DOM.

The engine prepares a noninteractive `img` inside the fallback container (directly inside its open ShadowRoot when present) while Native is visible. It reuses the decoded image and DOM node across handoffs, and releases them when the scope is retired or destroyed. The image is `inert`, hidden from accessibility and excluded from hit testing. The existing fallback and its children are never cloned, replaced, removed or assigned `inert`/`aria-hidden`; their listeners, values and application changes survive projection. Both `::before` and `::after` remain available to the application.

Supply an existing container such as `div`, `button` or a custom element. Replaced/void elements such as `img`, `input` and `video` remain unsupported as scopes; use their existing fallback container. The renderer may move the same container between parents, but must not replace a low-level scope's element or let two managers control it simultaneously. Notify the manager through `moved()` when changing its placement during projection.

The image is absolutely positioned within the fallback, which retains its layout box. As with the previous pseudo-element presentation, static hosts become positioned while the image is visible. Host and ancestor clipping, transforms and filters still apply. Open ShadowRoot insertion bypasses internal slot wrappers, not the host's own clipping. Closed shadow roots cannot be inspected; provide a fallback container that can render the image.

Engine-owned nodes carry `data-native-ui-projection-node` for their entire pooled lifetime. Renderers that inspect fallback children must exclude these nodes from application content discovery. A renderer that uses a MutationObserver to invalidate captures must also ignore insertion/removal and attribute changes of these nodes, changes inside them, and Engine-owned `data-native-ui-snapshot-*` attributes. Continue observing authored content, dimensions and disabled-state changes; ignoring all mutations on a projection host would hide real updates. Otherwise image preparation can invalidate itself and cause repeated capture/release cycles. The engine removes only its own nodes on disposal. Child insertion can affect structural selectors within the fallback, but does not add items alongside it in flex, grid or virtual lists.

### Notifications from the existing plugin

The low-level manager can subscribe to the existing plugin's events through `options.events`:

```ts
events: {
  addListener: (name, listener) => plugin.addListener(name, listener),
  update: ['setColors', 'setTabs', 'tabSelected'],
  projection: {
    native: ['shown'],
    web: ['transitionStarted'],
    none: ['hidden'],
  },
}
```

These are **notifications**, not intercepted method names. The plugin emits update events after its native changes succeed. A Web projection event must arrive before movement starts; it uses the previously prepared image. A native event requests restoration, but the image remains until the normal renderer acknowledgement confirms that Native is ready. A hidden event follows the plugin's native hide operation and retires the image; it does not invoke `hide()` or change application-owned fallback DOM. Appearance updates preserve the requested destination, including `none`.

For plugins with several surfaces, provide `accepts(event)` to select this scope's stable surface identity. Events shared by `update` and a destination are subscribed once and processed together. Conflicting destinations for the same event are rejected before subscription. Destroying the manager removes all its subscriptions, including registrations that resolve late after initialization fails. No public plugin methods are wrapped or replayed.

The manager converts private native file URLs with Capacitor internally. Plugin authors do not supply a URL resolver.

This section describes the lower-level manager for renderers that already own batch reconciliation, such as the Ionic adapter. Prefer the native registration in the plugin guides for a new integration; it owns startup, measurements and draw acknowledgements.

### Multiple fallbacks in one Native transaction

Use `createWebProjectionBatch(transport, options)` when several fallback elements must switch together. It uses the same image engine, one listener and one capture/cover/restore token. Pass `{ scope, element, control, ... }` for each entry to `batch.consider(revision, sources)`. Several native IDs may share one scope, such as a button group.

The batch derives its Document from the first nonempty `consider`; all subsequent scopes and sources must belong to that Document. Before this first update, `begin()` does nothing and `destroy()` is safe. A changed fallback requires a new scope. Scope identity participates in cache invalidation; an active presentation retains its captured scopes until restoration finishes.

`WebProjectionRequest` is an action-discriminated union. `prepare` requires `revision`, `viewportWidth` and `ids`; `cover` requires `token`; `restore` requires `token`, `viewportWidth` and destination `parts`; `painted`, `restored` and `release` require `token`; `reset` takes no payload. Empty preparation results and `{ shown: false }` mean the plugin should use its normal Web fallback. Use the plugin's existing ordered bridge; the engine does not retry user actions.

### Native handoff on both platforms

Call all view and snapshot lifecycle APIs on the main/UI thread. Native input frames use **points relative to the WebView on iOS** and **physical pixels relative to the reference view on Android**. `viewportWidth` is the Web viewport width in CSS pixels. Prepared parts sent to JavaScript are converted to CSS pixels.

On both platforms, `cover` installs the prepared entry image **before hiding the supplied live views**, within the same UI turn. Its boolean result reports whether this was possible; failure leaves visibility unchanged. Supply the actual views for every captured component. Do not separately hide views or create another entry copy.

```swift
let shown = snapshots.cover(token, in: webView, views: renderedViews, transient: movingSurface)
```

```kotlin
val shown = snapshots.cover(token, activity.window, webView, renderedViews, transient = movingSurface)
```

`transient: true` is for a moving foreground surface: it does not replace the background's `coveringToken`. Retire the entry copy with `retireCopy(token)` after Web image readiness. Before applying a normal native update, undo the engine's visibility changes with iOS `restoreControls()` / Android `restoreViews()`. For return, `restore` installs the cached return image, the plugin renders underneath it, and `retireCopy(token, entry: false)` retires it after the corresponding acknowledgement/readiness. These platform-native names remain idiomatic; the lifecycle is the same. `cover` is an entry operation, not a method to repeat on each normal update.

Token cleanup uses `release(token)`; owner teardown uses `reset()` (and Android `close()` when disposing its encoder). A surface manager must not reset another surface's captures. Web fallback remains the renderer's responsibility when a capture or native placement is unavailable.

The optional `eligible(source)` and `current(sources)` callbacks keep framework-specific surface selection outside the engine. `transient: true` supports a moving surface whose return image must be rebased. Arbitrary CSS transforms are not supported by native scroll tracking; such movement can use this image path.

The image transport accepts `WebProjectionRequest` and returns prepared token/parts or `{ shown: false }`. Parts use local `file:` URLs and CSS-pixel viewport coordinates. Requests use the plugin's existing ordered bridge:

| Action     | Native responsibility                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`  | Validate the current revision and IDs, then `NativeUICoveredSnapshots.prepare` using actual rendered frames.                                            |
| `cover`    | Validate the token and complete native surface ownership; create the entry copy and hide the associated native views. Return `shown: false` on failure. |
| `painted`  | Retire only that token's entry copy.                                                                                                                    |
| `restore`  | Rebase the prepared return copy to supplied frames. Never capture here.                                                                                 |
| `restored` | Retire only that token's return copy after the native update ACK and Web paint boundary.                                                                |
| `release`  | Release the named token, files and associated temporary views.                                                                                          |
| `reset`    | Owner teardown only; release all native capture resources.                                                                                              |

Use `NativeUICoveredSnapshots.observe` to notify the JS listener when interaction starts/ends. On iOS, captures rasterize the visible window with `drawHierarchy(in:afterScreenUpdates:)`, including the background under the clipped native component. Screen snapshot views are display replicas and are not used as bitmap sources. UIKit rasterization can differ from the live compositor for materials such as Liquid Glass; validate the appearance on physical devices with the backgrounds your plugin supports. Cache validity therefore includes layout and the plugin's visual-change notifications. The engine does not capture continuously or guarantee every possible renderer can be captured.

### Temporary storage and application permissions

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

[AdMob PR #487](https://github.com/capacitor-community/admob/pull/487) demonstrates a persistent image underlay for opaque test ads. That policy is not enabled globally: translucent UI would be composited twice, and video/SDK interactions require renderer-specific decisions. Never synthesize clicks through an image. The Native UI consumer uses the engine on both iOS and Android. Android acceptance tests exercise the real Capacitor bridge and translucent Compose content. Other SDK consumers still require their own integration and acceptance testing.

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
