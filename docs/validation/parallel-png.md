# PNG concurrency and Android Web-stage investigation

This follow-up compares the existing Rust path with serial postprocessing against
bounded two-worker postprocessing. Codec settings, pixels, file transport and
readiness conditions are unchanged. Each run rotates mode order, excludes three
warmup rounds and retains 30 samples per mode. Only one platform benchmark runs
at a time, with other builds and tests stopped.

## Android Web stages

The fixture now records separate monotonic durations in native and JavaScript
clock domains; it never subtracts a JS absolute timestamp from a native timestamp.
The JavaScript duration travels back with the acknowledgement. `dispatch_residual_ms`
is the native dispatch-to-ack duration less that JS duration; it includes native
bookkeeping, dispatch and bridge delivery, and is not a pure bridge measurement.

For the serial path in the final instrumented run:

| Observation                                |    Median |
| ------------------------------------------ | --------: |
| Whole post-prepare Web interval            | 301.05 ms |
| Native dispatch through JS acknowledgement | 191.49 ms |
| JS image load/decode/adoption barrier      | 152.05 ms |
| Latest image load event since JS start     |  65.95 ms |
| Decode/adoption barrier after latest load  |  82.85 ms |
| Two animation-frame callbacks              |  24.55 ms |
| Bridge delivery to UI callback             |  14.68 ms |
| Native visual-state callback               |  23.01 ms |
| Native draw and posted completion          |  41.55 ms |
| File open time, sum over 12 files          |   3.97 ms |
| File read time, sum over stream reads      |   3.16 ms |

These rows overlap and their medians must not be added. File open/read time is
synchronous I/O duration, not request queueing or the time the WebView takes to
consume a stream. The load-event/decode-barrier gap includes scheduling and
adoption; it is not isolated decoder CPU time. This screen's dominant observable
Web interval is image load/decode/adoption and readiness, rather than raw file I/O.
No production Web readiness condition or deadline was shortened.

## Bounded concurrency

- Android uses a shared fixed pool of two PNG workers. Its existing per-instance
  encoder coordinates results and keeps output order. All submitted work is joined,
  including after failure/interruption, before shared capture pixels are recycled.
- iOS uses at most two worker lanes per capture. Each lane uses an autorelease
  pool, and results retain the original part order. A failed part rejects the
  complete capture and removes completed files.
- Either platform uses serial processing if any crop exceeds 500,000 pixels.
  Thus two concurrently converting small crops contain at most one million pixels.
  Existing eight-million-pixel capture limits and cache ownership remain in place.
- Encoding, file write and iOS native decode run off the main thread. Existing
  capture, presentation and invalidation rules stay on the main thread.

The iOS encoder shares immutable Core Image contexts; Apple documents concurrent
rendering with the same [CIContext](https://developer.apple.com/documentation/coreimage/cicontext).
Dedicated concurrent tests compare serial and parallel PNG bytes for opaque and
translucent inputs. The existing precision/profile and fallback tests remain.

## First comparison

| Platform         | Serial p50 | Two-worker p50 |  Serial p90 | Two-worker p90 | PNG bytes (both) |
| ---------------- | ---------: | -------------: | ----------: | -------------: | ---------------: |
| iOS simulator    |  354.93 ms |      280.46 ms |   384.93 ms |      310.83 ms |        2,690,508 |
| Android emulator |  703.36 ms |      615.15 ms | 1,113.92 ms |      803.65 ms |          121,464 |

These are implementation/worker-count comparisons on the same fixture, not a
universal speedup claim. Each codec timing sum accumulates work on all workers;
with parallelism it is not elapsed wall time. `encode_span_ms` (iOS) and
`encode_write_span_ms` (Android) additionally measure first encoder entry to last
encoder return, including intervening scheduling/crop work.

All Android warmup PNG hashes matched across both modes. On iOS, the first cold
warmup had different captured artwork; both modes had identical PNG hashes for
warmup rounds 1 and 2. All three warmup rounds are excluded from latency results.
The same-input concurrent encoder regression is the deterministic fidelity check.

The first run's median sampled memory increase during encoding was 18.36→18.59 MiB
in iOS resident memory and 7.38→8.05 MiB in Android native heap. These are sampled
at encoder entry/exit relative to capture start, not true process peaks and not
cross-platform comparable. GPU memory, transient allocations between probes,
Java heap and energy are not comprehensively measured. The crop-size and worker
limits bound concurrent pixel conversion rather than total process memory.

## Reproduction

```sh
python3 scripts/benchmark-native-png.py android --device emulator-5554 --android-720p --modes Serial,Parallel --output /tmp/parallel-android.json
python3 scripts/benchmark-native-png.py ios --device <simulator-UUID> --modes Serial,Parallel --output /tmp/parallel-ios.json
python3 scripts/benchmark-native-png.py summarize --output /tmp/parallel-android.json
```

`--android-720p` temporarily sets 720×1440/density 280 and restores the preceding
size/density overrides on normal exit, exceptions and handled interruption. A
force-killed process cannot run cleanup. The Android runner is restricted to
`emulator-5554` and verifies that it is an emulator before installation.

## Regression validation

- Swift Engine: 30 tests passed, including same-input concurrent P3/alpha encoding,
  relative-overlap invalidation, shared images and cleanup.
- Android: the new same-input concurrent opaque/alpha encoder test passed along
  with the existing codec tests. In the full instrumentation run, three tests
  failed in the shared `activity()` setup while awaiting a JavaScript callback,
  before capture/encoding. All three passed isolated retries without changing
  setup or production deadlines. Other applicable tests passed; API23-only
  coverage remains skipped on API35. The initial full run is not reported as a
  clean suite pass.
- The real WebKit pipeline counter fixture passed after parallelization: repeated
  common movement and entry/return added no capture, encode, write, read or decode,
  artwork changes recaptured, and reset retained zero files. Fixture counters are
  synchronized so parallel worker increments cannot be lost.
- Supervisor and independent acceptance static reviews found no blocking issues.
  Both independently checked the first raw timing aggregation and claim limits.

## Final-code repeat

After the interruption-safe join correction and adding encoder-span probes,
the comparisons were repeated separately with all other builds/tests stopped.

| Platform         | Serial total p50 | Two-worker total p50 | Reduction | Serial p90 | Two-worker p90 |
| ---------------- | ---------------: | -------------------: | --------: | ---------: | -------------: |
| iOS simulator    |        355.09 ms |            294.78 ms |     17.0% |  394.38 ms |      305.37 ms |
| Android emulator |        605.77 ms |            555.29 ms |      8.3% |  885.91 ms |      871.56 ms |

The encoder span dropped from 137.01→67.71 ms on iOS and 121.67→76.36 ms on
Android. This includes intervening per-crop work/scheduling rather than isolating
codec CPU. Mode timing sums are not elapsed time. PNG bytes stayed 2,690,508
(iOS) and 121,464 (Android). Actual peak encoder calls were one and two.
The second run supports the direction of the initial observation, while its
smaller Android gain illustrates host variation. The Android p90 difference is
small; this is not evidence for a general tail-latency improvement.

Final sampled memory deltas were approximately 18.85→18.59 MiB resident memory
on iOS and 7.38→8.04 MiB native heap on Android. No claim about true peak process
memory follows from these probes. Both small-crop and worker limits remain.

Raw first/final samples are `parallel-{first,final}-{ios,android}.json`, each with
an environment/source `.metadata.json` sidecar. Local simulator UUIDs and paths
are omitted from committed sidecars. The first samples are exploratory snapshots
before the final interruption-safe join/probe changes. Final production source
hashes identify the implementation in this follow-up; documentation may be
updated after sampling. The Android display overrides were restored after each run.

Final-code disposition: supervisor **APPROVE** and independent acceptance
**APPROVE**, after independent aggregation of both final raw datasets and
matching current production-source hashes to the metadata. The additional
`--modes` typo/duplicate rejection was also verified.
