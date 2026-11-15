# Native surfaces in a scrolling feed

A native SDK view over a WebView receives its own touches. Moving its pixels when
the Web content scrolls does not let a drag starting on that view scroll the feed.

For a uniquely matched iOS overflow `UIScrollView`, retain one
`NativeUIScrollHosting(webView:scrollView:)` for that scroll owner's lifetime.
Call `host.place(view, frame: frameInWebView)` from the renderer's placement path.
`NativeUIScrollTracker.host(_:frame:)` provides the same behavior when the Engine
tracker owns the complete binding lifetime.

The Engine creates a transparent native scroll surface above the WebView. SDK
views remain interactive children of this surface. Each host represents one
logical scroll owner: the native surface and its matched Web overflow scroller.
UIKit owns hit testing, pan recognition and inertia. Offsets are mirrored in both
directions; momentum stays with whichever scroller received the gesture.

When contact begins on either side, the existing Window event interceptor stops
both scrollers before forwarding the original event to UIKit. SDK taps and long
presses retain their native handlers; no synthetic touch is sent. Unoccupied space
passes touches to the WebView. Inserting SDK views into WebKit's private overflow
hierarchy is insufficient because WebKit's hit testing can exclude those views.

Keep the host stable while dragging or decelerating. A renderer that replaces its
geometry tracker for each batch can retain the host separately and use
`host.matches(scrollView, in: webView)` to check whether its established mapping
still belongs to the same scroller. Do not guess a binding when several native
scrollers match a DOM container.

The renderer still owns SDK loading, clipping, author visibility, overlay
coverage and teardown. Remove a retired view from its superview and release the
host when the scroll owner is destroyed. A hidden surface must have hidden or
removed children. Releasing the host returns any surviving views to their
renderer parents at the current position without changing their visibility.
Reconcile content-size and viewport changes through `place`. Moving a view to
another host preserves its original renderer parent. Engine snapshot preparation
includes the native surfaces when checking motion and, with
`stopScrollBeforeCapture: true`, when stopping momentum on native contact. Idle
preparation waits for motion to settle. This does not make a traversal of only
the WebView’s descendants sufficient to stop its sibling native surfaces.
A hosted view already has native geometry ownership. Engine projection therefore
uses its prepared image during scrolling instead of adding a second native
geometry tracker. The entry image belongs to the same scroll surface, so it
inherits the viewport's motion and clipping. On contact, the host stops the
paired scrollers and reveals the SDK before UIKit chooses the original touch's
target. Taps and long presses therefore reach the SDK on the first contact.

## Android

Wrap the SDK view once in `NativeUIScrollHosting(webView, sdkView)` and give that
wrapper to the renderer's existing `NativeUIClippedView`. Keep the SDK view as the
projection capture source. The renderer continues to own placement and clipping:

```kotlin
val input = NativeUIScrollHosting(webView, sdkView)
val clipped = NativeUIClippedView(input)
// Add clipped to the renderer parent, and update clipped.place(...) as usual.
```

The wrapper preserves native taps, long presses and child interception vetoes.
A single-pointer movement beyond touch slop, before long press recognition,
cancels the SDK gesture and forwards the original gesture to WebView. Chromium
owns DOM hit testing, body or overflow scrolling, and inertia. The wrapper does
not maintain another scroll offset or fling animator. SDK contact also settles
WebView inertia before the SDK receives the contact. Multi-touch gestures and
SDK gestures that disallow interception retain their native ownership.

With `NativeUIProjection` in `VIEW` mode and the existing placement binding, the
prepared image owns pixels before the first forwarded Web movement. No capture
is started on that scroll path. During image presentation, the Window observer
retains original input while the existing placement/resume handshake measures
the current frame and waits for native drawing. It then dispatches those same
events through normal native hit testing, shifting their timestamps and delivery
together to preserve gesture durations. Each following gesture resolves its own
contact; focus loss or teardown cancels a partially delivered gesture. This
allows the first photo tap or long press to operate the SDK. A failed or timed-out
restore cancels that contact instead of delivering it to stale geometry.

Gesture forwarding requires an attached WebView in the same Window and
translation-only ancestors. Projection retains its existing document-start
WebView support requirement; the scroll wrapper itself supports API 23. Remove
the wrapper with the renderer's SDK view on teardown; detaching cancels a
forwarded gesture.

These APIs are opt-in. They do not add scroll handling to arbitrary SDK views
automatically. Validate the integration with the actual SDK: it may reserve
its own drag gesture or disallow parent interception.
