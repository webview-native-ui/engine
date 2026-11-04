# Shared controls for native adapters

The existing Engine package also owns the control implementation used by Capacitor Native UI.
No additional npm package or workspace is required.

- `@webview-native-ui/engine`: generic projection API; unchanged dependency boundary.
- `@webview-native-ui/engine/controls`: control runtime and transport contract.
- `@webview-native-ui/engine/controls/ionic`: optional Ionic overlay implementation.
- `@webview-native-ui/engine/integration`: the single shared transition/search integration state.

An adapter creates one `createNativeUI({ plugin, getPlatform, isAvailable })` instance and keeps it
for its lifetime. The plugin implements the `NativeUIPlugin` transport interface. The adapter owns
host registration, method dispatch, listener delivery, and lifecycle hooks; Engine owns rendering,
DOM ownership, extension acknowledgement, and teardown sequencing. Cordova can supply this same
transport without importing Capacitor. The Cordova Native UI plugin itself is a subsequent change.

SwiftPM exposes the optional `WebViewNativeUIControls` product, depending on `WebViewNativeUIEngine`.
CocoaPods exposes `WebViewNativeUIControls` with the same dependency. Android exposes the optional
`io.github.webview-native-ui:controls` artifact from `android/controls`; it depends on `engine` and
Compose. Generic Engine consumers keep their existing dependencies and Android minimum SDK 23.
Controls require Android API 24. Native adapters create `NativeUIController` and forward requests
and events. iOS receives JSON dictionaries and completion closures; Android receives JSONObjects.

The Ionic theme imports Engine integration directly. The Capacitor compatibility integration export
re-exports that module. Resolve a single Engine version in the application; do not bundle a private
copy of integration into the theme or adapter. The `/controls` entry does not load Ionic runtime code;
load `/controls/ionic` only when opting into Ionic overlays.

## External reserved regions

Applications supply viewport geometry; Engine does not import or call capacitor-foldable.
Pass its `getReservedRegions().regions` through `verticalBars.reservedRegions` at startup,
or call `handle.setReservedRegions(regions)` after posture, bar placement or viewport changes.
The public handle updates the running shell without restarting native controls.

```ts
import { Foldable } from '@erkamyaman/capacitor-foldable';
import { resolveVerticalBarsLayout } from '@webview-native-ui/engine/integration';

// In the application's existing layout refresh handler, using its running handle:
const metrics = await resolveVerticalBarsLayout(Foldable);
ui.setReservedRegions(metrics.reservedRegions);
```

Reuse the application's initial layout read, device-change listeners and resize handler.
The resolver owns no subscriptions. If refreshes overlap, the application must discard
stale results and stop applying updates when its owner is disposed.

`resolveVerticalBarsLayout(provider)` accepts an object exposing `getBarPlacement()` and
`getReservedRegions()`, without importing the device plugin. It returns logical `edge`,
`inset`, `toolbarTop` and `reservedRegions`. Unsupported or failed reads leave the
corresponding fields undefined. Web defaults belong to the theme's
`setVerticalBarsLayout(metrics)` (requires the corresponding theme layout-input update).
The resolver uses the current browser viewport and document direction to resolve the
physical occlusion.

Region frames use Web viewport CSS pixels and already include OS interaction margins;
Engine does not add `margins` again. Only active top-edge occlusions on the current rail
contribute to the resolved top origin. Missing, empty or unusable regions leave the
origin undefined so the applying layout can retain its defaults. Calling
`setReservedRegions()` clears the supplied geometry; calls after `destroy()` have no effect.

These APIs provide layout data only. Modal ownership timing and image capture are
unchanged in this change.

## Verification and release order

Run `npm run test:controls` for the migrated control tests and `npm test` for generic projection.
SwiftPM's `WebViewNativeUIEngine-Package` scheme covers both native targets. Android's
`:controls:testReleaseUnitTest` covers the migrated snapshot parser. Existing Capacitor transport
and hosted lifecycle tests remain in its repository, and the theme retains the real demo E2E suite.

Build and verify Engine first, including both signed Maven artifacts in the same Central bundle and
both npm-distributed podspecs. Release the Engine native artifacts and npm package at the same version
before refreshing the Capacitor and theme registry lockfiles. Candidate verification uses local npm
tarballs and a temporary SwiftPM path or local Maven repository; do not commit these temporary paths.
