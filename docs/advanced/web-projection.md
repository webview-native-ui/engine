# Low-level Web projection

Use the primitives below only if the surface helpers do not fit your renderer's
existing ownership model. `createWebProjectionSurface` already manages scopes and
batch handoffs; manually creating another manager for the same fallback would
introduce competing ownership.

For example, a renderer already owns one fallback container per native panel and
accepts native updates through its own revision protocol. A projection scope lets
it retain those ownership decisions while delegating image preparation and return
coordination. Prefer the surface helpers if page or modal grouping already fits;
a second manager on the same container would compete for its pixels.

A scope binds one existing Web fallback element for its lifetime. Obtain that element from your plugin's DOM; the engine does not create a replacement host or choose a page, stacking order or z-index. A different fallback element requires a new scope. Its Document is derived from `element.ownerDocument`.

```ts
import { createWebProjectionScope, createWebProjection } from '@webview-native-ui/engine';

const fallback = container.querySelector<HTMLElement>('[data-web-fallback]');
if (!fallback) throw new Error('Web fallback is missing');
const scope = createWebProjectionScope(fallback, 'my-plugin');
const projection = await createWebProjection(
  scope,
  {
    send: (request) => plugin.snapshot(request),
    listen: (listener) => plugin.addListener('snapshotInteraction', listener),
  },
  {
    wake: () => schedulePluginUpdate(),
    blocked: () => overlayIsActive(),
    revision: () => lastSentRevision,
  },
);
```

The container, bridge and update callbacks above belong to the consuming plugin. No `document`, `target`, `layer`, CSS selector or layer resolver is passed to the projection manager.

1. After an accepted native update, call `projection.consider(revision, sources)`. Sources associate the native IDs and viewport frames with their source DOM; they need not be inside the fallback element. Images are captured and decoded in advance.
2. Call `projection.changed()` for appearance changes, or `projection.changed(scrollElement)` to invalidate scroll geometry. Layout updates go through `consider`; use `invalidate()` for other geometry changes.
3. Before covering Native with a Web overlay, call `projection.begin()`. It displays already prepared pixels at the fixed fallback. No new capture or decode starts here. If capture is unavailable, the plugin keeps its ordinary Web fallback.
4. Exclude `projection.owners` from normal Native updates while the image owns those sources. `visibleOwners` keeps their return pixels while Native is being restored; `preparedOwners` identifies sources with prepared images. These arrays are read-only snapshots.
5. Call `projection.end()`, send the normal native update, then call `projection.updated(snapshotToken, acceptedIDs, revision)`. A newer acknowledgement containing all captured IDs retires the image.
6. Call `projection.destroy()` when disposing the surface. It releases only its own images and listener; the plugin owns final Native reset and its DOM.

The engine prepares a noninteractive `img` inside the fallback container (directly inside its open ShadowRoot when present) while Native is visible. It reuses the decoded image and DOM node across handoffs, and releases them when the scope is retired or destroyed. The image is `inert`, hidden from accessibility and excluded from hit testing. The existing fallback and its children are never cloned, replaced, removed or assigned `inert`/`aria-hidden`; their listeners, values and application changes survive projection. Both `::before` and `::after` remain available to the application.

Supply an existing container such as `div`, `button` or a custom element. Replaced/void elements such as `img`, `input` and `video` remain unsupported as scopes; use their existing fallback container. The renderer may move the same container between parents, but must not replace a low-level scope's element or let two managers control it simultaneously. Notify the manager through `moved()` when changing its placement during projection.

The image is absolutely positioned within the fallback, which retains its layout box. Static hosts become positioned while the image is visible. Host and ancestor clipping, transforms and filters still apply. Open ShadowRoot insertion bypasses internal slot wrappers, not the host's own clipping. Closed shadow roots cannot be inspected; provide a fallback container that can render the image.

Engine-owned nodes carry `data-native-ui-projection-node` for their entire pooled lifetime. Renderers that inspect fallback children must exclude these nodes from application content discovery. A renderer that uses a MutationObserver to invalidate captures must also ignore insertion/removal and attribute changes of these nodes, changes inside them, and Engine-owned `data-native-ui-snapshot-*` attributes. Continue observing authored content, dimensions and disabled-state changes; ignoring all mutations on a projection host would hide real updates. Otherwise image preparation can invalidate itself and cause repeated capture/release cycles. The engine removes only its own nodes on disposal. Child insertion can affect structural selectors within the fallback, but does not add items alongside it in flex, grid or virtual lists.

### Notifications from the existing plugin

The low-level manager can subscribe to the existing plugin's events through `options.events`:

```ts
events: {
  addListener: (name, listener) => plugin.addListener(name, listener),
  update: ['setColors', 'setTabs', 'tabSelected'],
  projection: {
    native: ['shown'],
    web: ['transitionStarted'],
    none: ['hidden'],
  },
}
```

These are **notifications**, not intercepted method names. The plugin emits update events after its native changes succeed. A Web projection event must arrive before movement starts; it uses the previously prepared image. A native event requests restoration, but the image remains until the normal renderer acknowledgement confirms that Native is ready. A hidden event follows the plugin's native hide operation and retires the image; it does not invoke `hide()` or change application-owned fallback DOM. Appearance updates preserve the requested destination, including `none`.

For plugins with several surfaces, provide `accepts(event)` to select this scope's stable surface identity. Events shared by `update` and a destination are subscribed once and processed together. Conflicting destinations for the same event are rejected before subscription. Destroying the manager removes all its subscriptions, including registrations that resolve late after initialization fails. No public plugin methods are wrapped or replayed.

The manager uses the host runtime's resource URL conversion internally (Capacitor or Cordova). Plugin authors do not supply a URL resolver.

This section describes the lower-level manager for renderers that already own batch reconciliation, rather than a single native-view registration. Prefer the native registration in the plugin guides for a new integration; it owns startup, measurements and draw acknowledgements.

### Multiple fallbacks in one Native transaction

For example, a toolbar contains two button groups with separate fallback hosts,
but the renderer hides and restores them in one native transaction. Independent
managers could expose one group before the other. A batch uses one handoff token
for the groups so they can cross the rendering boundary together.

Use `createWebProjectionBatch(transport, options)` when several fallback elements must switch together. It uses the same image engine, one listener and one capture/cover/restore token. Pass `{ scope, element, control, ... }` for each entry to `batch.consider(revision, sources)`. Several native IDs may share one scope, such as a button group.

The batch derives its Document from the first nonempty `consider`; all subsequent scopes and sources must belong to that Document. Before this first update, `begin()` does nothing and `destroy()` is safe. A changed fallback requires a new scope. Scope identity participates in cache invalidation; an active presentation retains its captured scopes until restoration finishes.

`WebProjectionRequest` is an action-discriminated union. `prepare` requires `revision`, `viewportWidth` and `ids`; `cover` requires `token` and includes `viewportWidth` and destination `parts` for transient movement; `restore` requires `token`, `viewportWidth` and destination `parts`; `painted`, `restored` and `release` require `token`; `reset` takes no payload. Empty preparation results and `{ shown: false }` mean the plugin should use its normal Web fallback. Use the plugin's existing ordered bridge; the engine does not retry user actions.
