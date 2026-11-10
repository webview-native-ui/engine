# Hypothesis-to-validation review

Two separate reviewers assessed the implementation and the experiment design:
a supervisor review and an independent acceptance review. Both initially
requested changes on the same two issues.

| Finding                                                                                          | Resolution                                                                                                                      | Evidence                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1: An iOS crop can contain another root's pixels, but the cache ignored relative root movement. | Match all source and crop rectangles under one common translation. Independent movement invalidates the cache.                  | Overlapping red/blue-root regression: individual movement recaptures, pixels equal a separate fresh capture, common translation reuses, and Native return pixels match PNG. Simulator test passed. |
| P2: Raw timings were recorded, but the fresh comparison harness was outside the repository.      | Include production-source-based generation, execution, raw samples, environment/source hashes and p50/p90 aggregation commands. | See [fresh comparison fixture](../../tests/performance/fresh/README.md). Historical raw JSON independently reaggregates to the published results.                                                  |

The reviewers found the separation between encoder improvement and avoided
pipeline work appropriate. Total timing includes copies/FFI and Web readiness;
cache-hit work is validated separately. The comparison changes codec settings
and opaque-channel policy as well as implementation language. It does not prove
that Rust alone causes the gain, or that an equivalently tuned native codec
cannot match it. Physical-device performance and peak memory remain unmeasured.

The supervisor independently reviewed the benchmark harness added in response
to acceptance feedback. The acceptance reviewer independently rechecks the
cache correction and regression added in response to supervisor feedback.

## Fresh rerun

The newly checked-in commands completed on both platforms. Reference JSON is
retained unchanged; these reruns confirm executable reproduction rather than
requiring identical latency on a loaded host.

| Platform         | Baseline total p50 | Proposed total p50 | Baseline p90 | Proposed p90 | Baseline / proposed PNG bytes |
| ---------------- | -----------------: | -----------------: | -----------: | -----------: | ----------------------------: |
| iOS simulator    |          440.18 ms |          342.31 ms |    467.81 ms |    387.33 ms |         2,629,867 / 2,690,508 |
| Android emulator |          891.79 ms |          727.61 ms |  1,070.49 ms |    974.96 ms |             143,258 / 121,464 |

Each mode has 30 retained samples after three warmup rounds. Android used
720×1440 at density 280 and its display overrides were reset afterward. An
Android run that overlapped another validation task was excluded in full and
rerun with other builds/tests stopped. The direction and approximate p50 gain
reproduced; neither median nor tail improvement is promised for other workloads.

Raw rerun samples and environment/source hashes are retained in
`review-rerun-ios.json`, `review-rerun-android.json` and their `.metadata.json`
sidecars. Local simulator identifiers and filesystem paths are omitted from the
iOS sidecar. The metadata records the pre-commit base plus exact source hashes.

## Final disposition

Supervisor: **APPROVE**. Independent acceptance: **APPROVE**.
Both initial findings are resolved with no remaining blocking requests. The
supervisor independently checked the new comparison harness, rerun aggregation
and production-source hashes. The acceptance reviewer independently checked
the cache correction and overlap regression. The real WebKit pipeline counter
fixture also passed again after the correction, including reset to zero files.

## Bounded-concurrency follow-up

The subsequent Web-stage investigation and PNG concurrency change received
fresh supervisor and independent acceptance reviews; both **APPROVE**. The
[follow-up record](parallel-png.md) contains the final-code measurements,
source hashes, regression outcomes and remaining limitations. Those results
compare serial versus two-worker Rust paths, separately from the initial
platform-default encoder comparison above.
