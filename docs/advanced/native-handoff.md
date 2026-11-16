# Native handoff for custom renderers

An existing renderer should forward its ordered `WebProjectionRequest` messages
to the native snapshot manager's `handle` method. This keeps request validation,
CSS-to-native coordinate conversion, cached image handoff and copy retirement in
the Engine. The bridge remains the plugin's own Capacitor or Cordova method; the
Engine does not depend on either framework's call object.

For example, a renderer already sends toolbar buttons as one native update and
knows which views belong to each button group. Forward image handoff messages to
`handle` instead of reimplementing coordinate conversion and copy retirement for
each group. Keep the group's capture eligibility and ordinary layout in that
renderer: the Engine cannot infer which sibling views may safely hide together.

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
Register the snapshot manager's Window observer and forward its complete events; see [pre-interaction capture](preinteraction-capture.md#window-integration). Do not add duplicate clip-level touch notifications.

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

Missing captures or placement use the renderer's ordinary fallback. See the [Web request contract](web-projection.md#multiple-fallbacks-in-one-native-transaction) for payloads.

For acquisition before native input, stop-before-measure ordering, invalidation
and timing events, use [pre-interaction capture](preinteraction-capture.md).
Capture limitations, including backdrop-dependent materials, are documented in
[platform limits](../reference/platforms.md).

## Native scroll tracking

A native control inside a Web scrolling list would otherwise need new placement
messages as the list moves. Use these bindings only when the renderer already
owns scroll reconciliation: a uniquely matched iOS overflow scroll view can
carry native content with it. Nested or ambiguous scrolling must use the ordinary
fallback instead of attaching content to the wrong scroll owner.

`readScrollPlacement(element, owner, identify)` measures one untransformed overflow owner. `createScrollBindings()` validates reuse and detects movement while acquisition is awaiting ACK. Keep `reuse` out of layout-deduplication signatures; it describes acknowledgement state, not layout.

On iOS, `NativeUIScrollBindings.replace` groups sources by owner and binds only an unambiguous matching `UIScrollView`. `update()` applies positions and clipping without rebuilding content. `NativeUIClippedView` preserves full content dimensions while restricting visible pixels and hit testing.

An established binding rejected by native loses ownership and may be freshly acquired through the **same** update/ACK path. A failed fresh acquisition stays on the fallback until a relevant layout/scroll-end event. Never add an immediate retry loop or replay user actions. A frame/props change does not recalibrate an established coordinate origin.

This uses WKWebView's internal overflow hierarchy without private class names. Missing/ambiguous views, nested scrolling, document scrolling, unsupported transforms, shaped clipping, or a moving unconfirmed owner cannot be bound. Do not claim support solely because a `UIScrollView` exists. For gestures starting inside SDK views, opt into [native scroll hosting](native-scroll-hosting.md) rather than adding another gesture-forwarding implementation. SDK accessibility behavior remains renderer-specific.

### Renderer-only capture on iOS

A `prepare` request may specify `captureMode: 'view'` to draw only the renderer views returned by the view selector, preserving transparent pixels outside their material. The default remains composited window capture. Renderer-only capture can change or omit backdrop-dependent blur and refraction; it does not guarantee transparency inside a glass surface. Missing, hidden or detached renderer views reject preparation. Android and older native binaries keep their existing capture route.

Moving DOM surfaces can provide a fixed viewport transfer layer through `WebProjectionOptions.imageSurface` (`HTMLElement`). The Web projection marks its prepare requests with `imageSurface: 'web'` so Native concealment preserves renderer layout. This changes placement, not the handoff protocol: every surface uses the same temporary Native entry and return copies. During motion, the decoded DOM images live on their source surface so its transform carries them. Translation does not invalidate their reusable capture; dimensions are compared at display-pixel resolution, while actual size and source changes still invalidate it. On iOS, each image part includes optional `anchorBounds` relative to the image crop, in viewport units. Renderers can supply `anchorFrames` for composite controls, such as the first actual toolbar item in a group. Moving targets use these bounds to retain capture padding without mixing capture-time Native coordinates with later DOM placement.

Keep renderer and source ownership alive during projection. The common entry and
return protocol above still applies; `imageSurface` changes placement, not image
lifetime. `layoutFrame(target, part, parts)` supplies current anchor placement
from the captured cohort and does not own visibility. Call
`updated(token, ids, revision)` only for the accepted native update; a revision
newer than the return request retires the displayed image. Cache reuse eligibility
and the currently displayed image lease remain separate.

On iOS, use `NativeUICoveredSnapshots.concealPixels(in:)` on the main thread when layout must remain measurable. It masks pixels and disables interaction/accessibility without changing `isHidden` or geometry. Its returned restoration closure is idempotent; overlapping leases restore the original mask and flags only after the last lease ends. Both composited and renderer-only capture use the same Native copy and drawing-completion contract.

## Image encoding and reuse

PNG encoding is bundled with the native packages; consumers do not need Rust or
an NDK. iOS retains 16-bit Display P3 and ICC metadata. Android uses the Rust
encoder for opaque sRGB images and its platform encoder for unsupported input.
Encoding failures retain the platform fallback.

Explicit renderer-view captures may reuse immutable images when the content
revision and eligible view state are unchanged. Increment the revision whenever
artwork changes, including animation or background changes affecting materials.
Do not opt backdrop-dependent content into reuse without tracking those changes.
Default iOS composited captures do not enable this renderer-view cache.

Native replies acknowledge reusable pixels with `reused: true`. Only then may
Web reuse its decoded image for the same URL and destination; other replies keep
the existing load/decode behavior. Tokens own separate leases on shared files.
Continue releasing retired tokens and reset the manager on owner teardown.
