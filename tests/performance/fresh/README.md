# Fresh-capture PNG comparison

This fixture reproduces the **implementation comparison** behind
`docs/validation/rust-png-ios-p3.json` and `rust-png-android.json`. It does not
isolate the performance effect of the Rust language. Both the codec and its
filter/compression/opaque-channel policy change. Cache reuse is deliberately
excluded; the separate image-pipeline fixture verifies that optimization.

Run from the repository root, with artifacts verified and platform build tools
installed. iOS requires Xcode/iOS 27 SDK and a booted iOS 27 simulator because the
original screen uses `UIButton.Configuration.glass()`. Android requires JDK 17+
(JDK 21 recommended), SDK 36, and a booted API 35 `emulator-5554`. The measured
Android screen was 720p; configure that emulator size before comparison (the reference rerun uses
`adb -s emulator-5554 shell wm size 720x1440` and `wm density 280`; restore
with `wm size reset` and `wm density reset` afterward). Do not
use a connected physical device. The runner fixes Android's serial and checks
`ro.kernel.qemu` before installing its benchmark app. It does not change screen
size or density.

```sh
python3 scripts/verify-native-png.py
python3 scripts/benchmark-native-png.py ios --device <simulator-UUID> --output /tmp/png-ios.json
ANDROID_SERIAL=emulator-5554 python3 scripts/benchmark-native-png.py android --output /tmp/png-android.json
python3 scripts/benchmark-native-png.py summarize --output /tmp/png-ios.json
python3 scripts/benchmark-native-png.py summarize --output /tmp/png-android.json
```

`--prepare-only` generates and compiles the fixture without installing or
launching an app. A normal run installs only `local.native.pngbench` (iOS) or
`local.snapshot.android` (Android), waits for 66 samples, writes raw JSON at the
chosen output, and writes environment/source hashes to a sibling
`.metadata.json`. Runs do not overwrite committed reference samples unless that
path is explicitly selected. A simulator/emulator app remains installed after
the run. Use an otherwise idle host and do not run both platform benchmarks or
build jobs concurrently. Failures/timeouts abort rather than dropping samples.

## Production correspondence and measurement boundaries

The runner copies current production capture code into a temporary project.
It changes exactly one PNG call, with a uniqueness assertion that fails if the
source changes. The production PNG wrapper is copied unchanged, and the
checked-in production native binary is linked. There is no second hand-maintained
snapshot implementation.

- iOS: `CoveredSnapshots.swift` uses its existing public `prepare` entry point,
  capture readiness, extended-P3 capture, RGBA16 conversion, native decode and
  file write. Only the PNG expression is replaced with a timed choice between
  the previous `CIContext.pngRepresentation(... .RGBA16, Display P3)` and current
  `NativeUIPngEncoder.encode`. The benchmark Rust branch deliberately does not
  silently fall back, so an encoder failure fails the run. iOS has 12 glass
  UIKit buttons on a gradient and uses composited capture, never view-cache reuse.
- Android: `NativeUISnapshots.kt` uses its public `prepare`, PixelCopy, crops and
  file transport. Only `NativeUIPng.write(image, stream)` is replaced by a timed
  switch between previous `Bitmap.compress(PNG,100,stream)` and the unchanged
  production wrapper. The latter includes its production fallback. The screen
  contains 12 opaque native buttons. `NativeUIWebReadiness` is also current
  production source. The benchmark adds only the same RectF validation helper
  expected by the production snapshot source.

Both run three warmup rounds followed by 30 measured rounds per backend. Backend
order rotates every round (`A,B`, then `B,A`). Every run uses fresh capture URLs,
clears the preceding Web images, shows native controls, and waits 100 ms before
starting the next sample. This delay and initial page loading are outside the
timed region. Controls are hidden after preparation; Web loads each PNG and
calls `Image.decode`, then waits two animation frames. Android additionally
uses production `NativeUIWebReadiness.draw`. These are draw-readiness signals,
not physical display latency. The two platforms therefore are not directly
comparable to one another.

`total_ms` starts before native preparation and ends at the Web acknowledgement.
`prepare_ms` ends at native capture completion; `web_ms` includes subsequent file
reads, JS dispatch, load/decode and draw acknowledgement. iOS `encode_ms` times
PNG conversion/encoding only; Android `encode_write_ms` also includes writing
the output stream. `rgba_ms` is a retained historical field and is zero; pixel
conversion is included in the production-wrapper timing, not separately timed.
The fixture also counts PNG bytes by reading files (iOS) or file length (Android)
after preparation, so this bookkeeping is part of `web_ms`/`total_ms`. It uses a
small local image resource handler, not the application's complete host bridge.
It does not measure opening/closing real application overlays. Those paths are
covered separately by the counter fixture and integration tests.

The summary excludes `trial < 3`, requires exactly 30 retained samples per mode,
and prints median, nearest-rank p90 and median PNG bytes. Historical checked-in
samples predate environment sidecars; they identify platform/screen conditions
in the guide but do not contain full host or SDK provenance. Re-running produces
new evidence, not identical numeric results. Host load and OS versions can change
results. Pixel/P3/alpha equivalence is checked by dedicated platform tests,
not inferred from timing or PNG size. These timing fixtures do not replace those
tests and do not perform pixel validation inside measured rounds.

## Alternative explanation and decision limit

The current controls compare deployed native defaults against the proposed
end-to-end encoder, including copies/FFI. They establish improvement for these
screens, **not that Rust itself is necessary**. iOS uses Up/fast compression and
conditionally RGB16; Android uses RGB/NoFilter/default compression for opaque
pixels. A native encoder exposing the same settings might obtain similar
results. Android's [official CompressFormat documentation](https://developer.android.com/reference/android/graphics/Bitmap.CompressFormat#PNG)
states that PNG ignores `quality`, so changing the existing `100` argument does
not provide a PNG compression/filter control. For iOS, the inspected Xcode SDK
`CoreImage.framework/Headers/CIContext.h` declarations for
`CIImageRepresentationOption` and `PNGRepresentationOfImage` expose no explicit
PNG row-filter or deflate-level setting. This is a finding about the inspected
API, not proof that every Apple/native encoding API lacks tuning options. No
same-settings native-codec candidate has been benchmarked.

A settings-only native candidate must preserve 16-bit Display P3/ICC and straight
alpha on iOS, and Android color/alpha handling, and must be compared with the
same fixtures and total timing boundary. This change has not implemented or
measured that third candidate. Accordingly the adoption rationale is measured
benefit of the packaged encoder plus shared configurable lossless implementation;
there is no claim that a tuned Swift/C/Kotlin/NDK codec cannot match it. A choice
requiring proof that Rust is better than every native alternative remains open.

No universal speedup, picture-heavy-screen behavior, peak memory, battery
improvement, or physical-device performance is inferred from this fixture.
