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
// The embedding adapter or application supplies geometry; Engine reads no device API.
const ui = await enableNativeUI({ verticalBars: { reservedRegions: regions } });
ui.setReservedRegions(updatedRegions);
ui.setReservedRegions(); // clear the supplied geometry
```

`reservedVerticalBarBoundary(regions, physicalEdge, width, height)` is a pure helper
exported from `/integration`. It resolves the active top reservation on the physical
rail edge using explicit viewport dimensions. Missing or unusable regions return
`undefined`; the applying adapter or theme owns defaults. No DOM or provider is read.

Region frames use Web viewport CSS pixels and already include OS interaction margins;
Engine does not add `margins` again. Only active top-edge occlusions on the current rail
contribute to the resolved top origin. Missing, empty or unusable regions leave the
origin undefined so the applying layout can retain its defaults. Calling
`setReservedRegions()` clears the supplied geometry; calls after `destroy()` have no effect.

For Ionic modal motion, native controls remain fixed above the supplied boundary.
Once the measured toolbar position crosses below it, the controls project at their
own position inside the sheet, so a prepared capture takes the sheet's moving
background instead of a stale rail band (rdlabo/ionic-theme-ios27#349).
Native rail ownership returns on crossing back. Toolbars whose position cannot be
measured, and modals that never settle below the boundary, keep the existing
image handoff. The existing iOS rail retains its 170 CSS pixel boundary when regions
are unavailable; Android continues to use its existing renderer path.
The existing image capture method is unchanged.

## Verification and release order

Run `npm run test:controls` for the migrated control tests and `npm test` for generic projection.
SwiftPM's `WebViewNativeUIEngine-Package` scheme covers both native targets. Android's
`:controls:testReleaseUnitTest` covers the migrated snapshot parser. Existing Capacitor transport
and hosted lifecycle tests remain in its repository, and the theme retains the real demo E2E suite.

Build and verify Engine first, including both signed Maven artifacts in the same Central bundle and
both npm-distributed podspecs. Release the Engine native artifacts and npm package at the same version
before refreshing the Capacitor and theme registry lockfiles. Candidate verification uses local npm
tarballs and a temporary SwiftPM path or local Maven repository; do not commit these temporary paths.
