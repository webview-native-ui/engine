# Android prepared-image drag entry

A prepainted opaque image can move with Web scrolling before a live native view is
hidden by a later bridge request. Android VIEW registrations with placement handoff
now observe the first one-pointer drag MOVE at the Window callback, before passing
that MOVE to the application/WebView. The observer never consumes or rewrites input.

## Entry and return

- DOWN and sub-slop movement leave native controls interactive. A drag starting
  inside the native source's screen bounds stays on the existing path.
- Each registration checks its prepared/drawn token, current native View identity
  and dimensions, visibility, capture eligibility, and scroll-region bounds and
  direction/range. Multitouch does not initiate this early path.
- Eligible registrations cover their native view immediately and notify their own
  Web session. A separate gesture region supports rounded Ionic hosts that cannot
  use native compositor scroll tracking. Missing/unready tokens stay native.
- The Web session adopts the early cover, retains placement ownership while the
  finger remains down, and restores after scroll settling. Existing generation,
  token, latest-placement and draw-ACK checks remain in use.
- Cache invalidation can precede delivery of the cover notification. The idle
  underlay is retained until native release acknowledges; an unclaimed native
  cover asks for current placement, and release waits for native drawing. Repeated
  invalidation cannot prematurely clear those pixels. Native hide/teardown cancels
  that retention, and an older completion cannot clear a successor's image.

No new PNG or bitmap is generated on the gesture path. The Window observer is
shared, with per-registration readiness/geometry metadata. Gesture recognition
runs only until the first qualifying MOVE; no new per-frame measurement loop or
bridge stream is added. Idle retirement can briefly retain the existing decoded
image until the bounded native acknowledgement. CPU/memory parity was not measured.

## Verification

An instrumented APK was run twice on Android emulator-5580 (API 36.1), once with
only the early native path disabled and once enabled. Each run used eight swipes
and two ads, with builds/tests stopped while recording. The served creatives were
different; these are timing observations, not a rate/performance comparison.

| Drag recognition to native `View.INVISIBLE` | Existing bridge path | Early native path |
| ------------------------------------------- | -------------------: | ----------------: |
| Samples                                     |                   16 |                16 |
| Median                                      |              22.5 ms |              1 ms |
| Maximum                                     |                90 ms |              4 ms |

The early hide ran before the consuming MOVE callback. These are Android UI-thread
state-change timings, **not physical display-frame or visible-overlap durations**.
The instrumented recordings had 204/204 and 214/223 eligible frames respectively,
with zero blank candidates in the existing image-content heuristic. That heuristic
does not establish zero overlap/flash on every display frame.

The final code removes the measurement logs and temporary feature switch; it also
makes explicit native hide/teardown cancel pending image retention immediately.
The normal early-hide path is unchanged. Detailed timing samples and APK checksum
are in [the evidence JSON](evidence/android-scroll-entry.json). Raw recordings and
bridge/native traces are under `/private/tmp/admob-native-entry-proof` in the
verification workspace.

Validation:

- Engine: build/typecheck, lint/format and 88 browser tests passed.
- Android: release lint; 18 instrumentation tests passed, with one API-23-only
  test skipped on API 36.1. New checks cover real native click delivery, callback
  order for multiple registrations, unprepared/uncapturable/released pixels,
  source hit regions, horizontal/out-of-region gestures and retirement recovery.
- AdMob linked to this local Engine: 46 Web tests and 84 Android unit tests passed.
- Clean APK: normal recording had 200/200 eligible frames, with no blank
  candidates. A second run waiting for both prepared ads had 219/226 eligible
  frames, also with no blank candidates. This is not a scroll-speed/FPS benchmark.
- Multiple-ad recording: 65 eligible frames per ad, no blank candidates or bridge
  errors. Mixed capture availability, one-ad reload/detach and pause were exercised;
  the unaffected ad retained its projection and pause removed both images.
- The prepared-ad run started with two cached PNGs and decoded no new image URL
  during the recorded scroll (its single recorded decode reused a pre-existing
  URL). Its final file probe returned no cache directory, so file-count sampling
  alone cannot establish allocation behavior throughout the run.

An earlier concurrent-build test run timed out while evaluating JavaScript during
an unrelated navigation fixture. The final full Android run was repeated without
parallel builds and passed. `lintDebug` also flags the pre-existing test Activity's
intentional JavaScript enablement; CI's `lintRelease` passes.

## Remaining scope

This is an Android opaque VIEW + placement-handoff optimization. Programmatic
scroll, ineligible captures, out-of-region/unsupported directions and gestures
owned by the native source keep existing behavior. It is not a universal atomic
compositor transition, and no iOS/Liquid Glass capture change is included.
