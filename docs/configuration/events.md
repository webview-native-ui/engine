# Connect plugin notifications

Use `receiveListeners` when native content or presentation changes after initialization.
These are successful-change notifications, not method interception. The
[Capacitor](../getting-started/capacitor.md) and [Cordova](../getting-started/cordova.md) guides show where
to forward them; this page defines the shared event contract.

For example, selecting another native tab changes the highlighted item but not
the bar's position. Without an update notification, opening a Web sheet can reuse
an image of the old selection. Emit the plugin's successful selection event and
include it in `update`. A hide operation is different: route its event to `none`
so a later appearance update cannot make the hidden bar reappear.

## Startup and routing

Forwarding notifications from the plugin lets the Engine retain the latest matching projection destination before the Web runtime subscribes. No separate state variable or initial-state callback is needed. Keep the plugin's application event delivery unchanged: the Engine records state without replaying notifications, updates, or user actions. Without a destination notification, it infers the initial destination from native view visibility. Registration must exist before the notifications it should observe.

If your plugin owns multiple registrations, pass the notification to each registration; `receiveListeners.match` selects the owning surface. Appearance updates do not change the destination. The renderer still owns native placement and visibility before connection.

With the default Web fallback, scrolling without a prepared image or native scroll binding keeps the Web fallback visible until the renderer confirms current native placement with its native-destination notification. An appearance update alone is not that confirmation. Consumers choosing native failure recovery must keep their own native geometry current.

## Choose successful update and presentation events

All incoming event declarations belong to `receiveListeners`. Its `update` list refreshes the image and any configured value bindings, its `projection` lists select the destination, and its optional `match` filters notifications for the owning surface.

| Notification                            | Where to emit it in the existing plugin                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `appearanceChanged` (an `update` event) | After a successful native appearance update, such as `setColors`                      |
| `transitionStarted` (`web`)             | Before the fallback DOM starts moving or a Web layer covers the native view           |
| `shown` (`native`)                      | After the plugin's existing show operation, or when returning from the Web projection |
| `hidden` (`none`)                       | After the plugin's existing hide operation                                            |

The names in the examples are conventions you choose, not reserved Engine methods. An `update` event refreshes the prepared image and configured values without changing the requested destination. It does not call `setColors` again.

Emit `transitionStarted` before the DOM starts moving, `shown` when native projection is requested again, and `hidden` after the plugin's own hide operation. Native capture, URL conversion, image preparation, draw acknowledgement, image retirement and listener cleanup stay inside the engine. The engine never invokes the plugin's `show`, `hide`, selection or ad-loading methods. End the registration with `projection.destroy()` on iOS or `projection.close()` on Android when the renderer is destroyed. Retain the registration for its full lifetime and call native APIs on the UI thread.
