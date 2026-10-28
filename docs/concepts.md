# Native UI in Web-driven screens

Use the Engine when a native view must coexist with Web scrolling, transitions or
overlays. A native tab bar, for example, can remain interactive during normal use,
yet visually sit beneath a Web modal when that modal opens. The application keeps
its Web navigation and layout instead of recreating the entire screen natively.

## Why a bridge call is not enough

A native view above a WebView is outside the DOM stacking tree. Increasing a Web
modal's `z-index` cannot cover it. Hiding the native view reveals whatever the Web
page draws underneath, which may look different; showing it again before layout
has settled can expose the wrong position.

The Engine handles the visual handoff between those layers. It prepares an image
while native content is available, presents that image in the application's DOM
when needed, and keeps it until native restoration is acknowledged. Preparation
is separate from presentation so opening an overlay does not wait for capture.

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
[projection contract](projection.md#projection-contract) for exact precedence and
restoration rules.

## Why the integration supplies a DOM container

The container gives the image its place in the application's layout and layer
structure. A native rectangle alone cannot tell the Engine which modal, clipping
ancestor or scrolling region should contain the image. The container can already
hold a Web fallback; its content and listeners survive projection.

For an ad, this might be a `native-ad` element in a scrolling feed. For a tab bar,
it might be a fallback navigation container below the page's overlay layer.
Choose a [supported container](projection-containers.md) with the intended layout
box. The Engine neither creates the application layout nor supplies an ad or tab
bar implementation.

## Choose the smallest integration that fits

| What you are building                                                                           | Start here                                    | Why this route                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A Capacitor plugin exposing a native view, such as a tab bar or a capturable advertisement view | [Capacitor plugin guide](capacitor-plugin.md) | Native registration owns runtime startup, measurements and handoff acknowledgements; keep the existing plugin API. |
| A Cordova plugin with the same need                                                             | [Cordova plugin guide](cordova-plugin.md)     | The same lifecycle uses Cordova's native hooks and resource handler.                                               |
| A renderer already batching many controls across pages and modals                               | [Renderer guide](renderer-guide.md)           | Group controls by lifecycle while retaining the renderer's existing placement and update protocol.                 |
| An Ionic application using an Engine-enabled plugin                                             | [Ionic overlay guide](ionic-overlays.md)      | One shared monitor connects Ionic overlay lifecycle to projection coverage.                                        |

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

## Decide whether the limits fit your UI

Images freeze both the control and any captured background. Content that must stay
live or interactive while covered needs a different presentation policy. SDK
capture restrictions still apply, and some platform compositor effects, including
Liquid Glass highlights, can differ from their captured appearance. The Engine
does not promise pixel-identical capture of every native view.

Validate your actual backgrounds, overlay transitions and restoration on supported
devices. If capture is unavailable, decide what the user should see in the Web
fallback before integrating. Read the [capture and platform reference](projection.md)
for eligibility, timing, storage and failure policies.
