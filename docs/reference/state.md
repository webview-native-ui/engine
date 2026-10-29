# Observe projection state

Projection state answers **where the component should be presented**. It is
independent of its value, such as a toggle's checked state or a selected tab.
See [value bindings](../configuration/values.md) for that connection.

For example, a tab bar unexpectedly remains hidden after dismissing a modal.
Inspect this attribute to distinguish a remaining `web` request from a `native`
request whose restoration is still pending. It helps diagnose the ownership
choice; it is not permission to reveal the bar or discard its image early.

A selector-based `NativeUIProjection` registration writes the read-only
`data-native-ui-destination` attribute on its current DOM container:

| Value    | Meaning                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- |
| `native` | Native presentation is requested.                                                               |
| `web`    | Web presentation is requested, explicitly or because a registered overlay covers the container. |
| `none`   | No presentation is requested.                                                                   |

Without a prior destination notification, startup derives the initial intent from
native view visibility; a hidden or absent view starts as `none`. The plugin's
projection events then select `native`, `web` or `none`. Overlay coverage
changes an otherwise native request to Web; it does not override an explicit
`none`. The Engine updates the attribute as it reconciles presentation and removes
it when the container is replaced or the registration is destroyed. Reserve this
attribute for the Engine rather than setting it from application code.

This is presentation **intent**, not an acknowledgement that a native frame or
image has finished drawing. Web presentation may use a cached native image or the
existing interactive fallback according to availability and the integration's
policy. Do not hide the fallback solely because this attribute says `native`:
the Engine's handoff keeps the previous representation until the next one is ready.

Use this attribute for diagnostics and application state that does not take over
visibility. Continue using the documented projection events to request a change.
See the [projection contract](projection.md#projection-contract) for ownership,
fallback and interaction rules. Internal snapshot attributes are not additional
public state APIs.
