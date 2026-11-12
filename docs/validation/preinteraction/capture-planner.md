# Cost-based capture planning and automatic Window interception

This replaces the earlier fixed “two bands / 40% area” rule and removes the application's requirement to implement a WindowHook.

## Acquisition plan

`NativeUICapturePlanner` is used by every iOS acquisition in `NativeUICoveredSnapshots`, including idle preparation, pre-dispatch promotion and explicit View capture. Cropping, Float16 P3 precision, PNG16 encoding and ownership remain shared.

Vertically overlapping regions merge first. Dynamic programming then considers every contiguous partition of those merged regions. It can select one union rectangle, two groups, three groups or more, and can merge nearby components while separating distant ones. Rectangles stay tight horizontally. No fixed count or area-percentage limit remains. The computation is quadratic in the number of disjoint vertical bands.

The initial assumption that only output pixel count matters was insufficient: 1×/2× output and narrow rectangles retained substantial hierarchy-rendering cost. A positive weighted fit of Window samples produced:

| Term                                                                 | Fitted ms | Production rounded ms |
| -------------------------------------------------------------------- | --------: | --------------------: |
| Per hierarchy draw                                                   |    7.0069 |                     7 |
| Per million pixels of Window-width × captured-height × native-scale² |    4.9775 |                     5 |
| Per million output pixels                                            |    2.4849 |                   2.5 |

The Window-width row-area term is an empirical predictor. It does not assert how UIKit renders internally. Equal total output pixels alone do not imply equal acquisition cost.

For full-width native-scale groups, the break-even point is **0.933 million saved pixels per additional draw**. For example, at width 466 points and scale 3, that is approximately 223 points of otherwise captured vertical gap. Narrow areas use both terms. The planner evaluates complete partitions instead of independently applying a gap rule.

View draws have different costs. They use the same planner with a conservative default of 7 ms per explicit-root draw plus 2.5 ms per million output pixels, preserving every root's draw order in each pass. Both measured View layouts select one pass. The per-instance `captureCostModel` and `viewCaptureCostModel` remain configurable for other renderers/devices; these defaults are not universal device calibration.

Full-window capture was included in measurement. The implementation does not enlarge a one-pass union to the full Window: its positive cost model predicts at least as much work, and the holdout did not establish a stable benefit from that expansion.

## Measurement and frozen-model verification

Device Hub's iPhone Duo iOS 27.2 runtime, SDK 27.1, Window 466 × 678 points, native scale 3. These are simulator-runtime measurements in Device Hub, not physical-device results.

- Calibration: **1,824 recorded acquisitions**, 152 plan/layout/scale combinations, 12 repetitions each. Output scales 1/2/3, actual toolbar/tab-bar, 2–12 Glass buttons, narrow and dense layouts, and explicit View capture.
- Verification: **456 recorded acquisitions**, 38 combinations, 12 repetitions each. Includes previously unused three-region spread, paired clusters and medium-width geometry. Coefficients were frozen before this run.
- First two repetitions per combination are excluded; p50/p90 use the remaining 10. Candidate order rotates by repetition. Timing includes Float16 context setup, serial hierarchy draws, image materialization and final crops; conversion/encoding and pixel-comparison hashing are outside this interval.
- The analyzer fits each calibration layout/scale with equal total weight, using nonnegative least squares on plan medians. The View default is conservative, rather than claiming the Window regression applies to root draws.

| Verification layout            | Selected passes | Union p50 | Selected p50 | Selected p90 |
| ------------------------------ | --------------: | --------: | -----------: | -----------: |
| Toolbar + tab bar              |               2 |  22.90 ms |     14.53 ms |     17.59 ms |
| Three widely separated regions |               3 |  25.75 ms |     21.46 ms |     22.98 ms |
| Four regions in two clusters   |               2 |  24.83 ms |     19.68 ms |     21.07 ms |
| Medium-width pair              |               2 |  18.67 ms |     12.53 ms |     13.41 ms |
| Narrow pair                    |               2 |  17.70 ms |     12.46 ms |     13.92 ms |
| Four evenly spaced regions     |               1 |  26.36 ms |     26.36 ms |     28.63 ms |
| Two explicit View roots        |               1 |  18.62 ms |     18.62 ms |     22.02 ms |
| Twelve explicit View roots     |               1 |  87.99 ms |     87.99 ms |    105.94 ms |

All eight selected plans matched the lowest measured p50 among the tested alternatives in this verification run. This is not a claim of universal optimality. Some calibration cases differed slightly from the model's preferred partition.

All **148 Window pixel comparisons** matched the union's decoded RGBA16 P3 crops exactly. Glass View captures were not byte-repeatable: in four verification comparisons, a fresh union also differed from the original union. That prevents attributing their differences specifically to partitioning. The selected View plans remain one union pass. A deterministic overlapping-root/alpha test separately forces split View capture and verifies identical PNG bytes and preserved root order.

## No application WindowHook

The Engine now intercepts the concrete registered Window class's existing `sendEvent` automatically, using public Objective-C runtime APIs. It adds a local override when the method is inherited, or wraps the class's own implementation. It preserves and calls the original implementation exactly once. Nested superclass wrappers and an existing explicit `NativeUISnapshotWindow` are deduplicated.

There is no Window replacement or runtime subclass/isa change. Unregistered windows do not acquire pixels. Wrappers stay installed for process lifetime to preserve other libraries' implementation chains; weak owner registration is removed on teardown. Other method replacers must chain correctly. `automaticallyInterceptsEvents = false`, set before registration, retains the explicit host-managed option.

An ordinary **`UIWindow`**—without subclassing or a manual call to the hook—completed all 36 production Web handoffs. The Device Hub press separately promoted a waiting request before the normal gesture notification and button action. Both resulting PNGs were byte-for-byte identical to the idle reference. That actual contact's acquisition hook took **34.36 ms**; it is a single input sample, distinct from the controlled acquisition matrix above.

The production fixture's controlled waiting-state hook p50 was **18.17 ms** and contact-to-Web-ready-ACK p50 was **49.05 ms**. Do not compare these directly with the matrix's draw-only measurements or interpret them as a guaranteed frame budget. The actual input observation demonstrates ordering and pixel fidelity, not a physical-device latency guarantee.

Apple API references and the integration/opt-out contract are in [pre-interaction capture](../../advanced/preinteraction-capture.md).

## Verification and evidence

- Hosted Engine XCTest: **42 passed**. Covers dynamic partition optimality against exhaustive enumeration, scale and root count, forced View splits with overlap/alpha, inherited/custom Window dispatch, nested superclass wrapping, repeated registration, teardown and opt-out, plus existing Engine behavior.
- SwiftLint: **0 violations**.
- Production pipeline: **36 successful handoffs**, exactly one prepare/acquisition per trial, followed by the actual Device Hub press described above.
- The previous turn's Web regressions remain applicable because production TypeScript was not changed in this follow-up: 257 Vitest and 168 Playwright tests passed.

Evidence files:

Device-container paths in published evidence are normalized to `/DEVICE_CONTAINER`; metadata records both original and normalized raw digests.

- `planner-matrix-results.json.gz`, `planner-matrix-metadata.json`: calibration data and compilation-source hashes.
- `planner-verify-results.json.gz`, `planner-verify-metadata.json`: frozen-coefficient verification data and hashes.
- `planner-summary.json`: fitted parameters, verification p50/p90, pixel comparison checks.
- `automatic-capture-results.json.gz`, `automatic-capture-metadata.json`, `automatic-capture-summary.json`: ordinary-Window handoff and actual contact results.
- `planner-matrix-planner.swift.gz`, `planner-matrix-CapturePlanner.swift.gz`: original calibration fixture and planner helper, before adding verification cases/frozen coefficients.

```sh
python3 scripts/benchmark-production-capture.py --planner --device DEVICE_UUID --output /tmp/planner-matrix.json
python3 scripts/benchmark-production-capture.py --planner --planner-verify --device DEVICE_UUID --output /tmp/planner-verify.json
python3 scripts/analyze-capture-planner.py /tmp/planner-matrix.json /tmp/planner-verify.json --output /tmp/planner-summary.json
python3 scripts/benchmark-production-capture.py --device DEVICE_UUID --output /tmp/automatic-capture.json
```

The matrix analyzer intentionally validates the recorded 466 × 678, native-scale-3 display geometry. Recalibrate its geometry assumptions and coefficients for another device rather than treating this dataset as transferable hardware performance.
