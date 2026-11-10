# Rust PNG and image-pipeline validation

Local worktree: `feat/rust-snapshot-png`, based on Engine v1.0.4 (`f4ad403`).

## Results

- Rust: six unit tests passed; rustfmt and clippy (`-D warnings`) passed.
- Browser: all 168 Playwright tests passed, including explicit Native reuse ACK,
  legacy same-URL behavior, lease cleanup and changed-image decoding.
- Controls TypeScript: all 251 tests passed.
- Swift: Engine and Controls package tests passed. The two presentations requiring
  a host also passed in the generated hosted Xcode project. Tests cover 16-bit
  P3, alpha fidelity, matching native/Web pixels, cached UIImage identity,
  movement, eviction, content changes and reset cleanup.
- Android: the API35 emulator suite passed in a serial run (API23-only fallback
  case is not applicable on API35). JNI pixel/alpha/P3 tests and Controls unit
  tests/lint passed. Real NativeUIProjection/WebView tests confirmed that moving
  and returning the same view image adds no file read or decode.
- npm archive, CocoaPods consumer, Maven AAR ABIs/notices/signatures/checksums,
  source/binary hash consistency, TypeScript lint, SwiftLint and Android lint
  passed. Native tests were directed to emulator-5554 for final validation.

Raw performance samples: `rust-png-ios-p3.json` and `rust-png-android.json`.
Measurements are fresh-capture fixtures with production encoder wrappers;
performance of every renderer or physical device is not inferred from them.

`image-pipeline-ios.json` records a complete real-screen WebProjection/native
handler run. Three moves, repeated same-content preparation, Web entry and
Native return did not add any capture, encode, file write/read or image decode.
An artwork change regenerated pixels, and destroy/reset left zero files.

## Reproduction

Use the commands in [maintenance](../maintenance.md#native-png-artifacts).
For the full counter fixture:

```sh
python3 scripts/verify-image-pipeline.py --device <booted-simulator-UUID>
```

The test uses opaque, backdrop-independent UIKit buttons for renderer-only
reuse. Default composited/window capture does not get this cache merely because
its geometry matches; backdrop pixels can change independently.

One existing Android drawing-ACK test reached its deadline during a parallel
local build. Its isolated retry and a subsequent complete serial suite passed
without extending production timeouts. Earlier 1080p fixture timeout and
physical-device performance remain separate work, as described in the guide.

Fresh-capture timing fixture, commands, measurement boundaries and alternative
explanations: [reproduction guide](../../tests/performance/fresh/README.md).

## PNG concurrency follow-up

The [bounded parallelism and Android Web-stage investigation](parallel-png.md)
records the next optimization: unchanged codec settings with one versus two
workers, finer Web timing probes, serial/parallel byte-equivalence tests and
sampled-memory limitations. These results are distinct from the original
platform-default-versus-Rust comparison above.
