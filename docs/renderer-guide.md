# Coordinate pages and modals in an existing renderer

Use this guide when your renderer already creates and positions multiple native
controls, batches their updates, and knows which page or modal owns them. The
Engine takes over image preparation, scope reuse and handoff cleanup so those
concerns do not need separate implementations for every overlay.

For a single native view, start with [Capacitor](capacitor-plugin.md) or
[Cordova](cordova-plugin.md) registration instead. For the shared model and limits,
read [concepts](concepts.md). The APIs below are for an existing renderer, not
additional steps required by those plugin guides.

## Group controls by the lifecycle they share

A **surface** groups controls that must hand off together, such as the buttons on
a page or modal. It is not necessarily one native view or image.
`createWebProjectionSurface` manages their prepared images and fallback scopes;
`createWebProjectionSurfaces` manages the lifetime of multiple such surfaces.

Separate groups matter because covering a background page does not necessarily
cover the foreground modal's controls. Sharing one lifecycle would make those
independent presentation decisions interfere with each other.

For example, Native UI uses separate surfaces for a background page and each modal:

| Surface         | Native content              | When a Web image is useful                                                 |
| --------------- | --------------------------- | -------------------------------------------------------------------------- |
| Background page | Toolbar buttons and tab bar | A Web modal or popover must cover the page's controls.                     |
| Modal           | Close and confirm buttons   | The modal moves during a drag, or another Web overlay covers its controls. |

When a modal opens, the background surface can switch to its prepared images while
the modal's own controls remain Native when appropriate. Closing the modal requests
restoration of the background controls at their current positions; their images are
removed after the accepted Native update. Separate surfaces prevent a departing
modal's images or late replies from taking ownership of the newly exposed page.

## Connect the existing renderer

Connect each phase to the corresponding event in your renderer. These snippets
show separate lifecycle points, not calls to execute together during initialization.
The renderer supplies `transport`, source IDs and frames, accepted revisions and
its existing update scheduler.

### Create a surface when its owner becomes available

Map native control sources to existing fallback containers. The collection reuses
the surface for repeated updates to the same owner:

```ts
import { createWebProjectionSurface, createWebProjectionSurfaces, type WebProjectionSurface } from '@webview-native-ui/engine';

const surfaces = createWebProjectionSurfaces<HTMLElement, WebProjectionSurface>();
const projection = await surfaces.ensure(page, () =>
  createWebProjectionSurface(transport, {
    namespace: 'my-renderer',
    target: (source) => source.element,
    wake: scheduleUpdate,
    blocked: () => transitionIsActive,
  }),
);
```

### Prepare during normal updates, hand off at presentation boundaries

An accepted native update provides the appearance to prepare. Beginning a handoff
uses that prepared image; ending one requests restoration rather than immediately
removing it. Retire the image only after the normal native update is acknowledged.

```ts
// After accepting an ordinary native update:
surfaces.consider(acceptedRevision, sources);

// When the framework reports coverage or motion for this owner:
projection?.begin();

// When that coverage or motion ends:
projection?.end();
// Send the renderer's normal native update, then on its acknowledgement:
surfaces.updated(token, restoredIDs, acceptedRevision);
```

### Retire a page or the renderer

Deleting an owner prevents late creation or restoration from reviving its controls.
Destroy the collection when the renderer itself is disposed.

```ts
await surfaces.delete(page); // Page retirement.
// At renderer teardown:
await surfaces.destroy();
```

## Placement and shared monitoring

The renderer supplies Native IDs and frames, source ownership, placement policy and
accepted update acknowledgements. Framework lifecycle events remain outside the
Engine; it does not infer modal semantics from arbitrary DOM mutations.

For renderer-owned fallback proxies, `canRelocate(target)` explicitly permits
`begin(layer)` to place those hosts in a supplied overlay layer. The Engine restores
their parent and sibling order after restoration, failure or disposal. Application
DOM is not relocated by default, and an application reparenting a proxy takes
precedence over restoring its old location.

A collection shares appearance, resize, orientation and document visibility
listeners across its surfaces, and ignores Engine-owned image events. Renderers can
exclude their own proxy events with `ignoreTarget`. `followMotion(moving, target)`
uses the renderer's existing moving-element map to rebase images only while their
own hosts animate; ancestor transforms already move the images without polling.
All listeners and scheduled frames are removed at disposal.

Repeated `ensure` calls share pending creation or the existing projection. Deletion,
DOM disconnection or renderer disposal prevents a late result from becoming active;
the Engine destroys it instead. A failed creation may be retried. The renderer
signals page retirement through its existing lifecycle and can inspect `keys()`
and `values()` during its normal update pass. The collection does not install a
second DOM mutation observer or a continuous polling loop.

## Verify the handoff in the consuming renderer

Exercise an opening overlay, dismissal, a moving modal and owner removal during
restoration. The background and foreground must retain their own controls; a late
acknowledgement must not restore a departed owner. Change position without changing
appearance to check image reuse, then change content or dimensions to check
invalidation. Also exercise missing images: the ordinary fallback must remain
available without delaying overlay startup.

The Engine coordinates ownership, but only the consuming application can verify
its layer choices and native placement. Implement the native side using the
[native handoff contract](projection.md#native-handoff-on-both-platforms), including
current destination frames and accepted update acknowledgements.

## Low-level Web projection

Use the primitives below only if the surface helpers do not fit your renderer's
existing ownership model. `createWebProjectionSurface` already manages scopes and
batch handoffs; manually creating another manager for the same fallback would
introduce competing ownership.

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

The manager converts private native file URLs with Capacitor internally. Plugin authors do not supply a URL resolver.

This section describes the lower-level manager for renderers that already own batch reconciliation, such as the Ionic adapter. Prefer the native registration in the plugin guides for a new integration; it owns startup, measurements and draw acknowledgements.

### Multiple fallbacks in one Native transaction

Use `createWebProjectionBatch(transport, options)` when several fallback elements must switch together. It uses the same image engine, one listener and one capture/cover/restore token. Pass `{ scope, element, control, ... }` for each entry to `batch.consider(revision, sources)`. Several native IDs may share one scope, such as a button group.

The batch derives its Document from the first nonempty `consider`; all subsequent scopes and sources must belong to that Document. Before this first update, `begin()` does nothing and `destroy()` is safe. A changed fallback requires a new scope. Scope identity participates in cache invalidation; an active presentation retains its captured scopes until restoration finishes.

`WebProjectionRequest` is an action-discriminated union. `prepare` requires `revision`, `viewportWidth` and `ids`; `cover` requires `token` and includes `viewportWidth` and destination `parts` for transient movement; `restore` requires `token`, `viewportWidth` and destination `parts`; `painted`, `restored` and `release` require `token`; `reset` takes no payload. Empty preparation results and `{ shown: false }` mean the plugin should use its normal Web fallback. Use the plugin's existing ordered bridge; the engine does not retry user actions.
