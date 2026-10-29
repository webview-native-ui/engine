# Reflect component values into the DOM

A native toggle, tab selection or text control can change while its Web fallback
is hidden. Reflect its current values so that the fallback and application can
observe the same selection when they become visible. This is separate from
[projection state](projection-state.md): a selected tab is component data, not a
request to move its rendering between native and Web.

Configure this connection in the plugin's existing `NativeUIProjection`
initialization. No application-side wrapper is required. These options work with
both Capacitor and Cordova registrations.

## Start with data attributes

Supply `readValues` to enable reflection. It reads the plugin's **current** values,
including programmatic changes; event payloads are not used as the value store.
Every returned key defaults to `data-native-ui-value-<key>`. Omit `readValues` to
keep the existing behavior without value requests.

For example, these arguments in a Swift registration expose the selected tab as
`data-native-ui-value-selected`:

```swift
receiveListeners: .init(update: ["updated", "tabSelected"]),
readValues: { [weak self] in
    ["selected": self?.selectedTabID ?? ""]
},
```

Use lowercase keys starting with a letter, followed by letters, digits or hyphens.
Return JSON-compatible values. Strings are written literally; numbers, booleans,
arrays, objects and null use JSON text. Null becomes the attribute text `null`;
an empty string produces an empty attribute. Neither removes the attribute, and
an omitted key leaves the previous value unchanged. Use `NSNull()` in Swift or
`JSONObject.NULL` in Kotlin to return JSON null (`JSONObject.put(key, null)`
removes the key instead).

The Engine reads values when the matching DOM appears, after page reconnection,
and on configured `update` events. It ignores replies for a departed
DOM or superseded request. The callback runs on the native UI thread: read stored
state rather than performing blocking work.

## Choose a DOM property when the component needs one

A Web component or form control may expose `value`, `checked` or another data
property instead of reading attributes. Override only those keys with `values`:

```swift
receiveListeners: .init(update: ["updated", "selectionChanged"]),
values: ["selected": .init(property: "value")],
readValues: { [weak self] in
    ["selected": self?.selectedTabID ?? ""]
},
```

The equivalent Kotlin registration arguments are:

```kotlin
receiveListeners = NativeUIProjection.ReceiveListeners(
    update = listOf("updated", "selectionChanged")
),
values = mapOf(
    "selected" to NativeUIProjection.ValueBinding(property = "value")
),
readValues = { JSONObject().put("selected", selectedTabID) },
```

Property assignment preserves JSON types: a boolean stays a boolean instead of
becoming an attribute string. Choose a writable data property supported by the
component. HTML, style and event-handler properties are not binding destinations.
A property override replaces attribute reflection for that key. Other returned
keys still use the default data attributes.

When property bindings target an autonomous custom element (such as `<my-toggle>`)
that is not defined yet, the
Engine waits for its definition before reading and assigning values. This keeps
an early assignment from hiding the component's eventual setter. It rechecks DOM
ownership and pending updates after the wait. Attribute-only bindings can reflect
values before the custom element is defined. Define customized built-ins (such as
`<input is="my-input">`) before enabling property bindings; their custom definition
name is not reliably available from the DOM.

## Keep application events in the component adapter

The Engine connects native state to the DOM. It does not implement framework
two-way binding or dispatch `input`, `change`, `ionChange` or other component
events. Initial reads, user selections and programmatic updates all follow the
same reflection path. Concurrent reads use the newest response, and responses
for a departed container are ignored.

Keep application notifications on the plugin's existing event API. The adapter
for a form control, custom element or framework decides how that native event
updates the application model. For example, a tab plugin's `tabSelected` event
can update the application's selected-tab state while the Engine separately
reflects the current selection into the fallback's `value` property. Do not
read the DOM from that event handler expecting the asynchronous Engine refresh
to have completed; use the plugin event's documented payload instead.

A custom element may react to a reflected attribute through its
`attributeChangedCallback`, or accept a property through its setter. Use that
hook to render the current value. Setters that emit application events retain
their own behavior; the Engine neither suppresses those events nor invents a
universal event shape. In particular, assigning a native input's `value` does
not itself notify a framework form.

The Engine does not invoke native setters, observe DOM properties to send values
back to native, or replay actions. Retain the component's existing Web-to-native
handler and avoid unconditional setter/event loops.

On teardown, reflected values remain available to the Web fallback. The Engine
removes its projection-state marker, but does not reset component data.
