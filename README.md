# WebView Native UI Engine

**Keep native UI in step with Web content.** Add scrolling, Web-layer projection and native restoration to your Capacitor or Cordova plugin without building a separate handoff system for each platform.

## What you can build

- **Native controls that coexist with Web modals and overlays.** Temporarily show the native surface's prepared image in the correct DOM layer, then restore the interactive native view when the overlay closes.
- **Native surfaces inside scrolling Web content.** Use supported native scroll tracking on iOS, or a prepared image during motion, including on Android. Return to the live native view when motion settles.
- **Consistent transitions without recreating native styling in CSS.** Prepared images preserve captured native pixels, including composited translucency, while the Web layer owns presentation.

These capabilities suit plugins with native toolbars, tab bars, players or eligible native SDK views. Your plugin keeps its controls, business actions and public API. The Engine handles the transition between the live native view and its Web presentation.

## Approach

Associate a native view with an existing DOM container. Tell the Engine when the content changes and whether it belongs in **native**, **Web** or **neither** layer. It prepares images ahead of transitions and coordinates their replacement and restoration.

The DOM container determines where Web projection appears, including its placement in a modal or other layer. Your plugin creates and sizes both surfaces and keeps native placement current. Projected images are noninteractive; your plugin provides any interactive Web fallback.

Prepared images avoid capture work at transition start. If no valid image is available, the configured fallback applies. Captured content is a still image, so live video, unsupported capture and unusual layouts need a renderer-specific policy.

## Add it to your plugin

This is a dependency **for plugin authors**, not an application-facing plugin. It supports iOS and Android through the same Engine package and native libraries. Ionic and Angular are not required; Ionic overlay coordination is optional.

- [Capacitor plugin guide](docs/capacitor-plugin.md) — install dependencies and add registration, events and teardown to your existing plugin.
- [Cordova plugin guide](docs/cordova-plugin.md) — integrate the same Engine with Cordova's lifecycle and resource handler, without a Capacitor dependency.

Native registration starts the Web runtime; applications do not need a separate Engine initializer for the base integration. Keep your plugin's normal API and notifications.

The current API is pre-1.0. Use matching, pinned Engine versions across npm and native dependencies. Android placement requires API 23+, with composited snapshots available from API 26+.

## Further reading

- [Projection behavior and advanced integration](docs/projection.md) — DOM requirements, lifecycle, fallback policies, optional Ionic support and lower-level APIs.
- [Development and releases](docs/maintenance.md) — repository structure, validation and publishing.

## License

[Zlib](LICENSE). Commercial use, modification and redistribution are permitted with the license's notice and attribution requirements. [NOTICE](NOTICE) preserves upstream MIT notices; the Engine's license does not change the licenses of applications or plugins that depend on it.
