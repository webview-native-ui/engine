# Pre-interaction capture

Select or acquire immutable pixels before a native control handles contact, so
its pressed appearance is not captured. PNG encoding, file delivery and Web
decoding remain asynchronous. This is the same handoff described in
[native handoff](native-handoff.md), with an earlier acquisition point.

## Window integration

`NativeUIProjection` registers its Window automatically, as does the iOS Controls
controller. Custom snapshot renderers must call `observeInteractions`, forward
the **entire event dictionary** to Web, and pass requests through `handle` on the
main/UI thread. Window acquisition requires this native integration; enabling a
Web adapter alone is insufficient. No application Window subclass or second
input dispatcher is needed.

### iOS

`NativeUICoveredSnapshots.observeInteractions(_:changed:)` wraps the concrete
Window class's `sendEvent` implementation using the public Objective-C runtime.
Acquisition precedes the original method; each event is forwarded once, including
subclasses that call an intercepted superclass. Unregistered windows are unaffected.

Wrappers stay installed so other libraries cannot call a removed implementation.
Registrations are weak and teardown clears ownership. Other interceptors must
preserve the implementation chain. A gesture recognizer alone does not guarantee
ordering before another recognizer's pressed appearance.

To retain idle-only acquisition, set this on main **before registration**:

```swift
NativeUICoveredSnapshots.automaticallyInterceptsEvents = false
```

### Android

`NativeUISnapshots.observeInteractions(window, changed)` returns a cleanup function;
call it on teardown. Do not also forward `NativeUIClippedView.interaction` for the
same Window. The Window observer already reports that input.

PixelCopy is asynchronous. Only requests that still need pixels defer original
SDK input through the existing Window replay, preserving event order and gesture
duration. Ready pixels keep normal synchronous dispatch. Optional acquisition
has a deadline before the input replay deadline, so capture failure does not
consume the SDK tap. Returning a projected SDK to valid native geometry is a
separate handshake; see [native scroll hosting](native-scroll-hosting.md#android).

Android advertises `prepareDuringInteraction` to keep a request armed during a
Web gesture. Idle acquisition waits for input to end; native contact can promote
that request immediately. Hosts without this capability retain their existing
interaction policy.

## State and ownership

| State at contact                                 | Action before native input                                  |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Image decoded and installed in Web               | Select it without another capture.                          |
| Immutable pixels acquired, processing incomplete | Pin that request and let processing finish.                 |
| Request armed, pixels not acquired               | Measure current frames and acquire before delivering input. |

A request must already have reached native with eligible sources. Owner IDs and
lifecycle epochs isolate surfaces. Visual changes retire next-use eligibility
without cancelling a selected capture; source replacement, revision changes,
navigation, viewport changes and teardown still reject obsolete results. Releasing
a token also retires its acquisition.

A Web fallback does not hide the native source while its selected contact request
is still being processed or decoded. Success transfers visibility through `cover`;
failure or the Web request deadline resumes fallback. Explicit `none` does not
wait. There is no guarantee of a pre-contact image before registration or after
source removal.

## Stop before measuring a native contact

Custom hosts may set `stopScrollBeforeCapture: true` on `prepare`; it defaults to
`false`. Apply the integrating plugin's opt-out when forwarding this flag.
Only contact within the supplied native views invokes this cancellation. It stops
the current fling, remeasures frames, and acquires pixels before SDK input; it does
not disable scrolling or stop an unrelated Web contact.

On iOS, idle acquisition also waits while relevant scroll views are tracking,
dragging or decelerating. Registered owners settle motion and layout before
pinning. Android sends the stop contact to WebView before PixelCopy. Hosted SDK
registrations move their existing inertia cancellation before acquisition; they
do not add another scroll offset or fling animator.

Stopping is not proof of successful capture. Failed or stale acquisitions use the
normal fallback. Keep activation-time cancellation for actions without an armed
capture when the integrating plugin requires it.

## Scroll invalidation

Scroll notifications remain necessary for image placement and composited backdrop
changes, including behind fixed translucent controls. Visual changes, including
virtual row recycling, use `change` with `retainPending: true`: retire completed
next-use pixels while keeping an unacquired request available. Its frame callback
reads current geometry; the next `prepare` replaces it atomically. Source/revision
invalidation and reset still cancel obsolete work.

The document listener covers ordinary background motion. Renderer-provided
`changed(owner)` also handles scroll events inside Shadow DOM that do not reach
the document. Taps and long presses remain native input.

## Idle capture

The Web manager observes DOM changes, scrolling and resource loads as well as
renderer updates, excluding Engine-owned nodes and mutations. On contact-capable
hosts it arms native immediately after coalescing notifications; native geometry
sampling and the configured wait run together. Contact may promote a request
before settling finishes. See [capture timing](../configuration/capture.md) for
`captureDelayMs` and its default.

The iOS capture planner groups regions to reduce acquisition work. Its cost model
is an internal tuning detail, not a capture-timing contract; see
[CapturePlanner.swift](../../ios/Sources/WebViewNativeUIEngine/CapturePlanner.swift).
Composited capture retains Float16 Display P3 before background PNG conversion.
Equal crops may reuse immutable files and decoded images, but ownership changes
still retire them. See [encoding and reuse](native-handoff.md#image-encoding-and-reuse).

## Timing

Listen for `${namespace}:capture-timing` on `window`. Nothing is sent externally.
Fields depend on the native host:

- `idle` / `processing`: request-to-ready and decode/install time; iOS also reports
  native wait, acquisition and processing times.
- `ready` / `waiting` / `processing` at contact: selection state and, when supplied,
  `mainThreadMs` for the acquisition hook.
- `acknowledged`: iOS acquisition-to-Web-acknowledgement time and, if applicable,
  contact-to-acknowledgement time, measured on one native clock.
- `notificationToReadyMs`: time since Web received selection, excluding preceding
  native acquisition. It is not total contact latency.

These acknowledgements do not prove physical display presentation.

## Limits

Acquisition uses the main/UI thread; even a short acquisition can exceed a display
frame. The existing capture and handoff deadlines may fall back under load.
DOM notifications do not observe every Canvas, video, CSS/compositor animation or
shadow-root update; supply renderer invalidation for those changes. Stable bounds
do not prove settled materials. See [platform limits](../reference/platforms.md)
for unsupported surfaces and Liquid Glass differences, and validate the actual
SDK and backgrounds used by the integration.
