# Deferred placement on Android

Use this only when an existing renderer defers native placement while an opaque
image owns presentation. Basic registrations do not require these callbacks.

For example, an opaque native advertisement moves through a scrolling feed.
Once its image follows the DOM, repeatedly laying out the hidden native view adds
work without changing visible pixels. Defer that placement and apply the latest
position before revealing native content, so it does not jump back to the old
location. Keep ordinary placement tracking if the view cannot use an opaque image.

Android VIEW consumers can read `isProjecting` on the UI thread after a successful
cover to defer same-size native placement work. Keep only the latest accepted placement;
continue validating sequence/generation, and process hide, resize and teardown immediately.
Supply `beforeNativeReveal` to apply that pending placement synchronously before normal
restoration, failure recovery, or active-image release reveals native pixels. The engine
clears `isProjecting` before invoking the callback, so applying placement must not defer
again. The callback may run without pending work and must be idempotent. Clear consumer
pending work on hide/destroy and validate the loaded View identity before applying it.
The callback does not replace content/size invalidation or JavaScript geometry tracking.

### Final placement when returning from an opaque image (Android)

A plugin that normally measures and posts native placement on every scroll can opt
into a final placement handoff. Pass `updatePlacement: (JSONObject) -> Unit` to its
Android `NativeUIProjection` registration and bind its Web host with
`bindProjectionPlacement(element, measure, invalidate)`.

- `binding.projected` becomes true only after native confirms the image handoff.
  While true, the plugin can reuse that host's last placement in full placement
  batches and skip measuring it. Other hosts continue their ordinary updates.
- `measure()` returns a JSON object synchronously. The engine includes it in the
  existing restore request (or an active-image recovery request). Native validates
  the active image token and View identity, calls `updatePlacement`, then reveals
  native and acknowledges its draw. No extra bridge round trip is introduced.
- The plugin must validate its own identity, generation and per-host sequence in
  `updatePlacement`. Throw to reject a stale or invalid placement. A final update
  for one host must not cause updates for another host to be dropped.
- `invalidate()` is called after a failed handoff request. Clear optimistic
  placement/deduplication caches and schedule ordinary placement reconciliation.
- Dispose the binding when detaching a host. Session ownership prevents an old
  registration's delayed acknowledgement from clearing a new registration's
  projection state. Pause, author visibility and layout changes must still use
  the plugin's normal visibility/invalidation paths.

This opt-in does not change registrations without `updatePlacement`. Android rejects
`updatePlacement` unless `captureMode = CaptureMode.VIEW`; live video and other ineligible captures
continue native placement tracking under `failedFallback = NATIVE`.
