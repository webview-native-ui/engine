# Pre-interaction capture on iOS

Engine automatically acquires composited pixels before UIKit dispatches the first contact when the latest image has not yet been acquired. It preserves the appearance before the button's press highlight or Liquid Glass response begins. Conversion, PNG encoding, file delivery and Web decoding continue asynchronously.

## Window integration

**Application code does not need a WindowHook or a special UIWindow subclass.** `observeInteractions` installs automatic interception when the renderer first registers its existing Window. `NativeUIProjection` and Controls' `NativeUIController` already use that API.

The implementation uses the public Objective-C runtime to wrap the concrete Window class's `sendEvent` implementation. It preserves the original implementation and forwards each event exactly once, including subclass calls through an already wrapped superclass. Acquisition runs before the original method. It does not change the Window object's class or replace its instance. Unregistered windows are forwarded without acquisition.

Wrappers remain installed for the process lifetime so later wrappers from other libraries never call a removed IMP. Weak registrations and capture ownership are cleared on teardown. Other libraries that replace the same method must preserve the implementation chain; arbitrary non-chaining replacements cannot be made interoperable by Engine.

To disable pre-interaction acquisition, set this on main **before registration**:

```swift
NativeUICoveredSnapshots.automaticallyInterceptsEvents = false
```

With interception disabled, Engine retains its existing idle capture behavior.

Custom transports should use `observeInteractions(_:changed:)`, forward the entire dictionary to the Web listener, and pass requests through `handle`. Android retains its existing acquisition behavior.

Apple documents [Window event dispatch](https://developer.apple.com/documentation/uikit/uiwindow/sendevent%28_%3A%29) and [adding an inherited-method override](https://developer.apple.com/documentation/objectivec/class_addmethod%28_%3A_%3A_%3A_%3A%29). A [gesture recognizer receives touches before its attached view](https://developer.apple.com/documentation/uikit/uigesturerecognizer/touchesbegan%28_%3Awith%3A%29); that does not establish its ordering relative to other recognizers implementing press appearance, so it is not used as the pre-dispatch guarantee.

## State and ownership

A capture has an owner, request ID and lifecycle epoch. Initial DOM construction and subsequent changes use the same invalidation path.

| State at first contact                                              | Action before normal input dispatch                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Latest image decoded and installed in Web                           | Select that image; no new acquisition                            |
| Latest immutable pixels acquired; processing or delivery incomplete | Pin that request and continue its existing processing            |
| Latest request still waiting for acquisition                        | Promote it to synchronous acquisition, then forward normal input |

Selection precedes touch invalidation. Later content changes retire the next-use cache eligibility, while an explicitly selected request can finish the current handoff. Source invalidation, navigation, Window replacement, viewport changes and teardown still reject invalid results. Owner IDs isolate independent surfaces; old results cannot overwrite newer cache entries.

A request must already have reached native with eligible sources. Before the first registration, after source removal, or on acquisition failure, Engine uses the configured fallback. It cannot reconstruct a missed pre-contact frame after UIKit has dispatched the input.

## Idle capture

The Web manager observes document DOM changes, scrolling and resource loads in addition to renderer updates. Engine-owned projection nodes, attributes and image loads are excluded. The native request is armed immediately after coalescing notifications, rather than waiting for the entire debounce on the Web side.

`captureDelayMs` defaults to 50 ms. Native geometry sampling runs during that interval, requiring three consecutive unchanged samples; it does not add another fixed 50 ms after the debounce. This is a settling policy, not proof that every Glass or CSS animation has finished. Contacts can promote the request before settling finishes.

All iOS acquisitions—idle, promoted at contact, composited Window and explicit View capture—use `NativeUICapturePlanner`. Conversion, PNG and cropping semantics remain shared.

Capture regions retain 12-point padding and pixel alignment. Overlapping vertical intervals merge, including transitive overlaps; their rectangles stay tight horizontally. Dynamic programming compares every contiguous grouping of the remaining bands, including one union rectangle. It selects the lowest estimated cost; there is no fixed two-band limit or percentage threshold.

The Window estimate is:

`milliseconds = 7 × draws + 5 × rowMegapixels + 2.5 × outputMegapixels`

`rowMegapixels` is the sum of captured heights times Window width times native display scale squared, divided by one million. It is an empirical proxy: smaller output buffers did not proportionally reduce hierarchy rendering time. `outputMegapixels` uses each actual capture rectangle and output scale. This is a measured predictor, not a claim about UIKit internals.

For full-width regions at native scale, one additional draw needs to save approximately **0.933 megapixels** to pay off. Narrow rectangles use both area terms, rather than treating the output buffer size as the only work.

Explicit View capture uses the same planner with a separate conservative estimate: `7 × root draws + 2.5 × outputMegapixels`. Each pass preserves every root's original draw order. The measured View fixtures both select one pass. The internal cost estimates are based on Device Hub measurements. Acquisition stays serial on main.

Composited captures on the enabled path use Float16 extended Display P3 and `afterScreenUpdates: false`. Background conversion retains the existing PNG16 Display P3 encoder and two-worker limit. Direct 8-bit display capture and the experimental C encoder are not adopted.

After acquisition, Engine compares the valid Float16 crop pixels with the last comparable capture for the same owner and geometry, on a background queue. Exact equality reuses the existing PNG files, native images and decoded Web images; PNG conversion, native decoding and file writes are skipped. Content notifications retain the previous completed capture until its replacement is ready. Appearance, layout and scroll changes can make that image ineligible for ordinary presentation without releasing its pixels or cancelling a pre-contact selection. Failed replacement captures retain the baseline. Source ownership changes and explicit lifecycle invalidation still release it. Comparison buffers are limited to 32 MB per owner; unsupported or larger captures use normal processing. In-flight comparisons retain their source files through token release, while lifecycle invalidation still rejects stale completion.

## Timing

Listen for `${namespace}:capture-timing` on `window`. No telemetry is sent externally.

- `stage: idle` or `processing`: `native.waitMs`, `native.acquisitionMs`, `native.processingMs`, `requestToReadyMs`, and `decodeAndInstallMs`. Native processing includes conversion, encoding, native decode and file writing.
- Contact selection: `stage: ready`, `waiting` or `processing`, with `mainThreadMs`. This measures the acquisition hook itself, not every UIKit or bridge cost in the event dispatch.
- `stage: acknowledged`: `acquisitionToReadyMs` and, when contact preceded readiness, `contactToReadyMs`. These use one native clock through the Web decode/install acknowledgement, including the return bridge. They are upper bounds on Web usability, not proof of a displayed compositor frame.
- `notificationToReadyMs` starts when Web receives the native contact notification; it excludes the preceding synchronous acquisition. Do not use it as total contact latency.

## Limits

Acquisition still blocks the main thread. A 25–30 ms capture is not a guaranteed single frame at 60 or 120 Hz. Ready and processing cases avoid this acquisition cost at contact.

DOM notifications do not observe all visual changes: Canvas, video, ongoing CSS animation, compositor-only updates and unobserved shadow-root changes need renderer-provided invalidation. Resource loads and known native updates improve coverage but are not a universal paint observer. Unknown changes can leave a supposedly current cache stale. Native geometry stability also does not guarantee settled Glass brightness.

The validation uses Device Hub's iPhone Duo iOS 27.2 runtime. Performance on physical devices and other layouts must be measured separately; exact idle/pre-contact PNG equality is demonstrated for the static striped toolbar/tab-bar fixture, not all Glass scenes.
