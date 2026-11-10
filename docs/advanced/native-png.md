# Native image capture, encoding and reuse

The Engine keeps capture, color conversion, visibility and presentation on the
platform. Rust encodes PNG pixels behind the existing native API. Applications
continue using the existing SwiftPM/CocoaPods and Maven dependencies; Cargo and
an NDK are not required by consumers.

## Complete handoff path

| Stage           | Behavior                                                                                                                                                                   | Work avoided on reuse                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Scheduling      | Existing debounce coalesces updates and prepares images before the overlay opens. Content revision and layout remain independent where the renderer supports view capture. | Unchanged completed presentations do not prepare another image.                                                                  |
| Capture         | UIKit and PixelCopy/Canvas remain responsible for pixels. Window/backdrop capture is not reused across unrelated captures.                                                 | Eligible renderer-only captures reuse pixels for position-only movement.                                                         |
| PNG             | Rust encodes on the existing background worker. iOS preserves integer 16-bit Display P3 and ICC; Android uses RGB only after verifying opacity.                            | A native view-cache hit performs no capture or PNG conversion.                                                                   |
| Save            | Fresh images retain the existing app-private file transport.                                                                                                               | Cache hits retain the immutable file URL instead of writing another PNG.                                                         |
| Native decode   | iOS creates the entry/return UIImage from the encoded PNG so Native and Web use the same pixels.                                                                           | The iOS view cache also retains this decoded UIImage.                                                                            |
| Web load/decode | A fresh URL is loaded and decoded before adoption. Replacements can borrow a completed image for the same immutable URL and target.                                        | Same-URL replacements reuse the decoded DOM image without another src assignment or decode call.                                 |
| Presentation    | Existing entry/return copies and paint acknowledgements remain in place.                                                                                                   | Reopening a prepared presentation requires neither capture nor encoding.                                                         |
| Release         | Token ownership is separate from pixel ownership. Shared files and images remain alive until their final lease is retired.                                                 | Idle caches are bounded; replaced/unleased files and DOM images are cleaned up. Reset and native teardown remove retained files. |

The file transport is intentional: it continues using the host's existing
resource server, without moving PNG bytes through JSON/base64 or installing a
new bridge/resource handler. On a cache miss, one file write and the Web read
remain necessary for that transport. This change removes duplicate work on
reuse rather than replacing the host protocol.

## Cache eligibility and invalidation

Android already cached explicit renderer-view captures. Its cache now also
checks the source window, native size, layout direction, alpha and resource
configuration, and rejects reuse while source layout is pending. It still
recovers evicted files and invalidates on content changes, source replacement,
size changes and reset.

iOS adds one bounded renderer-view cache, with at most eight million retained
pixels. The existing `handle` protocol opts in when
`captureMode: 'view'` is explicitly selected; its request revision identifies
renderer content. The existing public `prepare` signature remains unchanged
and does not automatically enable content caching. The revision must change when the
renderer's artwork changes. Cache keys also include weak source-view/window
identity and drawing order, traits, scale, bounds, transform, alpha, crop size and anchor offset.
Only a common translation of all source views and crops can rebase existing pixels;
individual movement changes overlap pixels and invalidates the cache. Clipping, resizing, source replacement,
trait changes, missing files and reset invalidate reuse. Default composited
capture is unchanged. A native registration that does not support view capture
does not become eligible automatically.

A new token may refer to an existing immutable PNG. Releasing the older token
must not delete a file or clear the DOM image still used by its replacement.
Native cache hits explicitly acknowledge `reused: true`. Without that acknowledgement,
older binaries and custom transports retain the previous load/decode behavior,
even for identical URLs. The browser reuse path checks this flag, URL, destination,
completed decoding and src;
changed URLs are decoded normally. It retains no additional permanent decoded
cache beyond the existing current presentation and bounded DOM pool.

Do not use renderer-only reuse for backdrop-dependent content without updating
its content revision. Native-owned video/animation or other ineligible captures
still require the renderer's existing eligibility policy. This change does not
replace drawing acknowledgements with fixed sleeps or reuse arbitrary window
screenshots after their backgrounds change.

## Encoding behavior

- iOS: Core Image renders straight RGBA16 in Display P3; Rust converts native
  sample byte order to PNG byte order, retains ICC and uses Up/level 1. Completely
  opaque images use RGB16; translucent pixels remain RGBA16. Native restoration
  and Web decode the same PNG. Encoding failure or unsupported dimensions use
  the existing Core Image encoder.
- Android: sRGB ARGB_8888 input is copied through a DirectByteBuffer and JNI.
  Rust checks every alpha sample before using RGB/NoFilter/level 6. Transparent,
  wide-gamut or unsupported input uses Bitmap.compress. JNI output is copied to
  a ByteArray and freed exactly once.

The encoder rejects malformed dimensions, row strides and truncated input.
Native callers retain their existing fallback and capture eligibility rules.

## Validation and measurements

Source is based on Engine v1.0.4 (`f4ad403`), including the recent P3 and moving
surface fixes. Earlier 8-bit measurements do not describe the current iOS path.
The initial serial Rust implementation was checked in isolated real-screen fixtures using
production encoder wrappers, not a synthetic pixel array.

| Platform                             | Existing total p50 | Serial Rust total p50 | Existing PNG bytes | Rust PNG bytes |
| ------------------------------------ | -----------------: | --------------------: | -----------------: | -------------: |
| iOS 27, 12 UIKit controls, 16-bit P3 |          454.07 ms |             352.21 ms |          2,629,867 |      2,690,508 |
| Android 15, 720p, 12 native buttons  |          721.75 ms |             599.02 ms |            143,258 |        121,464 |

Each row interleaves modes, warms up three rounds and measures 30 per mode.
Total includes capture readiness, capture, copies/FFI, encoding, file transport,
Web image decode and drawing confirmation. These are emulator/simulator
measurements with host-load variation, not physical display latency or a
promise for every screen. iOS keeps 16-bit P3 fidelity: time drops about 22%,
while PNG size is about 2.3% larger. Android time drops about 17% and PNG size
about 15%. Raw samples are in `../validation/rust-png-ios-p3.json` and
`../validation/rust-png-android.json`. These timings measure fresh captures;
cache-hit work elimination is validated separately rather than folded into the
fresh-capture speedup.

The iOS cache regression checks that movement leaves the draw count unchanged,
retains the same PNG and UIImage, and changes content/size or file eviction
forces another capture. It also verifies independent token release and reset
cleanup. Browser regression checks that a same-URL replacement keeps one decode
and the identical DOM image, releases the old token safely, and a changed URL
performs a new decode. Existing Android tests exercise movement reuse, file
recovery, appearance/content invalidation, document reset and entry/return
visibility. Rust and platform tests cover pixel precision, transparent fallback,
P3 profiles, stride validation and ownership.

### Real-screen pipeline work counts

`python3 scripts/verify-image-pipeline.py --device <simulator UUID>` connects the
actual WebProjection manager to the actual native snapshot `handle` API, with
12 opaque, backdrop-independent UIKit buttons and a local WebKit file handler. It counts work in
temporary instrumented copies of production code; production has no counters.
The fixture also completes the Native/Web entry and return acknowledgements.

| Stage                                     | Captures | PNG encodes | Writes | Native decodes | Web reads | Web decodes | Retained files |
| ----------------------------------------- | -------: | ----------: | -----: | -------------: | --------: | ----------: | -------------: |
| First preparation                         |        1 |          12 |     12 |             12 |        12 |          12 |             12 |
| Three moves and same-content preparations |        1 |          12 |     12 |             12 |        12 |          12 |             12 |
| Web entry and Native return               |        1 |          12 |     12 |             12 |        12 |          12 |             12 |
| Artwork changed                           |        2 |          24 |     24 |             24 |        24 |          24 |             12 |
| Destroy and reset                         |        2 |          24 |     24 |             24 |        24 |          24 |              0 |

Counts are cumulative. Therefore both position-only reuse and entry/return add
zero capture, encode, save, read or decode work. Changing artwork generates
fresh pixels and replaces the old files. `../validation/image-pipeline-ios.json`
contains the observed counters. The fixture verifies these invariants in CI.
Android's real NativeUIProjection/WebView regression
`viewImageReuseSkipsFileReadAndDecodeAcrossMovement` separately counts file reads
and image.decode calls across two moving entry/return cycles; both stay unchanged.

Existing demo integration, other picture-heavy screens, video, physical-device
performance and peak memory remain separate validation work. The earlier 1080p
Android fixture hit the existing draw timeout; this change does not claim to
resolve that timeout.

Fresh-capture timing fixture, commands, measurement boundaries and alternative
explanations: [reproduction guide](../../tests/performance/fresh/README.md).

### Bounded PNG postprocessing follow-up

Fresh captures now process small crops with up to two PNG workers; large crops
(over 500,000 pixels each) stay serial. Codec settings, pixels and Web readiness
requirements are unchanged. Android uses a shared two-thread pool, and iOS limits
each capture to two worker lanes. Results preserve source order; failures join
all work before cleanup. See [the worker-count comparison and Android Web-stage
breakdown](../validation/parallel-png.md) for controlled measurements and limits.
