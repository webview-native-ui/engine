# Beyond the WebView.

**Bring Native UI seamlessly into Web apps.**

Build your screens with the flexibility of the Web and the controls and capabilities of native platforms. WebView Native UI Engine helps them work together as one experience, while keeping your Web layouts and navigation.

## Web UI. Native UI. One experience.

A native component should feel like part of the screen around it. For example:

- **Scroll together.** A native ad moves with the surrounding Web content as the reader scrolls through a feed.
- **Layer together.** A Web alert appears over native navigation controls. Close it, and those controls are ready for native interaction again.

Scrolling and overlays are examples of a broader goal: letting Web UI and Native UI coexist throughout the screen's lifecycle.

![Conceptual view of a Web overlay above a native surface and WebView content](docs/assets/hero.png)

_Conceptual view of overlay presentation. The Engine projects native appearance into the Web layer; it does not reorder the actual native view within the DOM._

[Watch the 23-second demo](docs/assets/beyond-the-webview.mp4): native controls beneath a Web alert, followed by a native ad scrolling with Web content. Recorded on iOS Simulator.

## Built for plugin developers

WebView Native UI Engine is a library for **Capacitor and Cordova plugin developers**. Integrate it into a plugin to bring native components into Web-driven screens, without making each application build its own coordination between rendering layers.

A native view above a WebView does not automatically participate in DOM scrolling, clipping or stacking order. A Web modal cannot simply cover it with a higher `z-index`. The Engine coordinates presentation across that boundary, so you can focus on the controls and native capabilities your plugin provides.

Use it for toolbars, tab bars, controls and capturable SDK views. Keep your existing plugin API and business logic; applications gain these capabilities through the plugins they use.

## How it works

The plugin supplies a native view and a DOM container that defines its place in the Web layout. The Engine coordinates DOM measurement, supported native scroll tracking and the handoff between native and Web presentation.

When the Web layer needs to own presentation, the Engine displays a prepared image of the native component in that container. When native presentation can resume, it coordinates placement and restoration of the interactive view.

The image is a temporary visual projection, not a second interactive control. It does not forward clicks or play live video. Capture eligibility and platform rendering limits still apply, including differences in Liquid Glass highlights. When a suitable image is unavailable, the integration uses its configured Web fallback. See [concepts and limits](docs/concepts.md) and [platform support](docs/reference/platforms.md) before choosing a component.

## Start building

The Engine supports **iOS and Android**. Ionic and Angular are optional. Start with a native view and its DOM container, then connect the lifecycle notifications your UI needs. The integration guides cover runtime startup and optional framework support.

| Start here                                                     | Why                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Basic initialization](docs/getting-started/initialization.md) | Register a native view and its DOM container with the minimum required setup.         |
| [Capacitor plugin guide](docs/getting-started/capacitor.md)    | Connect the Engine to an existing Capacitor plugin.                                   |
| [Cordova plugin guide](docs/getting-started/cordova.md)        | Use the same lifecycle through Cordova's native hooks.                                |
| [Documentation](docs/README.md)                                | Find optional settings, renderer APIs and reference by the problem you need to solve. |

Use matching Engine versions across npm and native dependencies, and retain dependency lockfiles for reproducible builds. Android placement requires API 23+, with composited snapshots available from API 26+.

## Contributing

For repository development, verification and publishing, see [development and releases](docs/maintenance.md).

## License

[MIT](LICENSE). Commercial use, modification and redistribution are permitted with the license's notice and attribution requirements. The Engine's license does not change the licenses of applications or plugins that depend on it.
