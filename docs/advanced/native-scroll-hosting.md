# Native surfaces in an iOS scrolling feed

A native SDK view over a WebView receives its own touches. Moving its pixels when
the Web content scrolls does not let a drag starting on that view scroll the feed.

For a uniquely matched iOS overflow `UIScrollView`, retain one
`NativeUIScrollHosting(webView:scrollView:)` for that scroll owner's lifetime.
Call `host.place(view, frame: frameInWebView)` from the renderer's placement path.
`NativeUIScrollTracker.host(_:frame:)` provides the same behavior when the Engine
tracker owns the complete binding lifetime.

The Engine creates a transparent native scroll surface above the WebView. SDK
views remain interactive children of this surface. UIKit handles taps, drags,
touch cancellation and inertia. On a touch beginning inside a hosted SDK view
or its matched Web overflow, the existing Window event interceptor ends the
associated native surface and Web scroller’s deceleration before forwarding
the original event to UIKit. SDK callbacks receive the real touch;
no tap or long-press event is synthesized. Content offsets are synchronized in both
directions with the matched Web overflow. Unoccupied space passes touches to the
WebView. Directly inserting SDK views into WebKit's private overflow hierarchy
is insufficient: WebKit's hit testing can exclude those inserted views.

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
This API is opt-in, iOS-only, and does not change Android registrations or add
scroll handling to arbitrary third-party views automatically.
