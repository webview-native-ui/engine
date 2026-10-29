# Native UI in Web-driven screens

The goal is to combine the flexibility of Web layouts and navigation with native
controls and capabilities in one screen. Applications keep their Web-driven UI;
plugins supply native components. The Engine coordinates presentation between
them so each component can coexist with the surrounding screen throughout layout
changes, interaction and navigation.

## Why a bridge call is not enough

Creating a native view does not give it a place in the DOM. A view above the
WebView does not automatically follow a scrolling container or participate in
its clipping and stacking order. A higher Web `z-index` cannot cover it. Simply
hiding and showing it can reveal a different appearance or restore it at an
outdated position.

The shared integration model is a native view paired with a DOM container. The
container identifies where the component belongs in the Web screen. The plugin
provides native content and reports changes; the Engine coordinates measurement,
prepared appearance and the handoff between presentation layers.

## What coexistence looks like

These situations share the same presentation model. Each integration connects the lifecycle and value notifications it needs:

| Situation                                                | Desired experience                                                                 | How the shared model helps                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| An eligible native advertisement sits in a Web feed      | It stays aligned with the content as the reader scrolls.                           | The DOM container supplies geometry; supported native tracking or temporary Web projection follows the movement.     |
| A Web alert opens over native navigation controls        | The alert covers their appearance, then native interaction returns when it closes. | Lifecycle notifications or the Ionic adapter request coverage; the Engine coordinates image handoff and restoration. |
| A page or modal changes layout                           | Its native controls return at the current location rather than an old rectangle.   | Geometry and restoration are coordinated with the owning container's lifetime.                                       |
| A native toggle changes while its Web fallback is hidden | Returning to HTML does not reveal the old value.                                   | Optional value bindings reflect component data independently of presentation.                                        |

Scrolling does not always mean moving a live native view. Supported iOS overflow
layouts can use native scroll bindings; Android uses temporary image presentation,
and unsupported layouts follow the configured fallback policy. Images do not
provide live SDK interaction. See [platform limits](reference/platforms.md) and
[scroll binding constraints](advanced/native-handoff.md#native-scroll-tracking).

The Engine prepares images while native content is available and retains them
through the handoff until native restoration is acknowledged. Preparation is
separate from presentation so opening an overlay does not wait for capture.
Application-specific lifecycle decisions still need notifications; registering a
view does not automatically detect every framework's overlays.

## Three presentations, with different purposes

| Presentation     | What the user sees                                    | Why it is used                                                                |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Live native view | The actual interactive control or eligible SDK view   | Normal native interaction and rendering.                                      |
| Web projection   | A prepared, noninteractive image in a DOM container   | The native appearance can move with Web content or sit beneath a Web overlay. |
| Web fallback     | The application's own HTML, or its chosen empty state | The integration remains usable when a suitable image cannot be prepared.      |

A projection is not a second live control. It does not forward clicks, animate
video, or reorder the actual native view beneath individual DOM elements. The
configured destinations `native`, `web` and `none` express where content should
belong; the Engine chooses the handoff mechanism. See the
[projection contract](reference/projection.md#projection-contract) for exact precedence and
restoration rules.

## Why the integration supplies a DOM container

The container gives the image its place in the application's layout and layer
structure. A native rectangle alone cannot tell the Engine which modal, clipping
ancestor or scrolling region should contain the image. The container can already
hold a Web fallback; its content and listeners survive projection.

For an ad, this might be a `native-ad` element in a scrolling feed. For a tab bar,
it might be a fallback navigation container below the page's overlay layer.
Choose a [supported container](reference/containers.md) with the intended layout
box. The Engine neither creates the application layout nor supplies an ad or tab
bar implementation.

## Choose the smallest integration that fits

| What you are building                                                                           | Start here                                             | Why this route                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A Capacitor plugin exposing a native view, such as a tab bar or a capturable advertisement view | [Capacitor plugin guide](getting-started/capacitor.md) | Native registration owns runtime startup, measurements and handoff acknowledgements; keep the existing plugin API. |
| A Cordova plugin with the same need                                                             | [Cordova plugin guide](getting-started/cordova.md)     | The same lifecycle uses Cordova's native hooks and resource handler.                                               |
| A renderer already batching many controls across pages and modals                               | [Renderer guide](advanced/renderer.md)                 | Group controls by lifecycle while retaining the renderer's existing placement and update protocol.                 |
| An Ionic application using an Engine-enabled plugin                                             | [Ionic overlay guide](configuration/ionic-overlays.md) | One shared monitor connects Ionic overlay lifecycle to projection coverage.                                        |

See [native initialization](getting-started/initialization.md) for the minimal registration
and a guide to optional settings versus advanced APIs.

A Web modal alone does not require the renderer APIs. Start with native
`NativeUIProjection` registration unless you already own multi-control
reconciliation. Applications normally gain Engine support through an integrating
plugin rather than creating registrations themselves. Other Web frameworks can
use their own transition notifications; Ionic is optional.

## Where responsibilities meet

| Engine                                                              | Consuming plugin                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| DOM measurement, image geometry and supported native scroll binding | Creating, attaching, positioning and sizing native views             |
| Startup, event subscriptions and native draw acknowledgements       | Providing the fallback DOM at the correct layer                      |
| Prepared image cache, decoding, display and retirement              | Reporting appearance changes and the intended projection destination |
| Native capture and temporary return images                          | Providing native views and SDK capture eligibility                   |
| Image invalidation, token cleanup and observer teardown             | Owning business actions and the interactive Web fallback             |

A DOM container does not necessarily contain an interactive Web replacement: a button plugin may provide an HTML button as its fallback, while an advertising plugin may leave the container empty when native content is unavailable. Image handoff is explicit and noninteractive. The engine never forwards clicks through an image or replaces SDK click/impression handling.

Native registrations can also [reflect current component values](configuration/values.md)
into their fallback host. This is independent of [presentation intent](reference/state.md):
a selected tab is component data, while `native`, `web` and `none` describe where
it belongs. Application events and framework form integration remain with the
component adapter.

## Decide whether the limits fit your UI

Images freeze both the control and any captured background. Content that must stay
live or interactive while covered needs a different presentation policy. SDK
capture restrictions still apply, and some platform compositor effects, including
Liquid Glass highlights, can differ from their captured appearance. The Engine
does not promise pixel-identical capture of every native view.

Validate your actual backgrounds, overlay transitions and restoration on supported
devices. If capture is unavailable, decide what the user should see in the Web
fallback before integrating. Read the [capture and platform reference](reference/platforms.md)
and [projection contract](reference/projection.md) for eligibility and failure policies.

[Documentation overview](README.md)
