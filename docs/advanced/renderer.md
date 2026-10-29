# Advanced: coordinate pages and modals in an existing renderer

Here, a **renderer** means the part of your plugin that creates native views and
updates their layout and appearance. Use this guide when it manages multiple native
controls, batches their updates, and knows which page or modal owns them. The
Engine takes over image preparation, scope reuse and handoff cleanup so those
concerns do not need separate implementations for every overlay.

For a single native view, start with [Capacitor](../getting-started/capacitor.md) or
[Cordova](../getting-started/cordova.md) registration instead. For the shared model and limits,
read [concepts](../concepts.md). The APIs below are for an existing renderer, not
additional steps required by those plugin guides. See [native initialization](../getting-started/initialization.md)
for the basic API and its optional settings before choosing this route.

## Group controls by the lifecycle they share

A **surface** groups controls that must hand off together, such as the buttons on
a page or modal. It is not necessarily one native view or image.
`createWebProjectionSurface` manages their prepared images and fallback scopes;
`createWebProjectionSurfaces` manages the lifetime of multiple such surfaces.

Separate groups matter because covering a background page does not necessarily
cover the foreground modal's controls. Sharing one lifecycle would make those
independent presentation decisions interfere with each other.

For example, a plugin rendering toolbar buttons and a tab bar can use separate
surfaces for a background page and each modal:

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
its existing update scheduler. In this example, `ownerOf(element)` is the
renderer's existing lookup of the page or modal that owns a control.

### Create a surface when its owner becomes available

Map native control sources to existing fallback containers. The collection reuses
the surface for repeated updates to the same owner. The owner passed to `ensure`
is a lifecycle key, not a source filter: `surfaces.consider` broadcasts the batch
to every surface. Each surface uses `eligible` to select only its own controls;
two surfaces must not manage the same fallback container:

```ts
import { createWebProjectionSurface, createWebProjectionSurfaces, type WebProjectionSurface } from '@webview-native-ui/engine';

const surfaces = createWebProjectionSurfaces<HTMLElement, WebProjectionSurface>();
const projection = await surfaces.ensure(page, () =>
  createWebProjectionSurface(transport, {
    namespace: 'my-renderer',
    target: (source) => source.element,
    eligible: (source) => ownerOf(source.element) === page,
    wake: scheduleUpdate,
    blocked: () => transitionIsActive,
  }),
);
```

### Prepare during normal updates, hand off at presentation boundaries

An accepted native update provides the appearance to prepare. Beginning a handoff
uses that prepared image; ending one requests restoration rather than immediately
removing it. While a surface owns the image, exclude its `owners` from ordinary
native rendering so live controls do not appear above the covering Web layer.
Use `visibleOwners` for return-image ownership while restoring. Retire the image
only after the normal native update is acknowledged.

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
[native handoff contract](native-handoff.md), using `NativeUICoveredSnapshots.handle` on iOS and `NativeUISnapshots.handle` on
Android. Supply eligible native bounds and complete views allowed to hide; Engine
validates requests and converts destination coordinates. Your renderer still
applies normal native layout and reports accepted update acknowledgements.

For different ownership needs, see [low-level Web projection](web-projection.md).
Update scheduling is independent: use the optional [update queue](update-queue.md)
only when it fits the renderer's reconciliation policy.
