# Cover native UI with Ionic overlays

Use this adapter when an Ionic modal or another covering Web overlay should appear
above Engine-managed native content. Native registration handles capture and
restoration, but it cannot infer Ionic's presentation lifecycle from a native
view. This shared monitor supplies that coverage decision for all registrations.

Applications use this adapter with an Engine-enabled plugin. Plugin authors first
integrate through the [Capacitor](../getting-started/capacitor.md) or
[Cordova](../getting-started/cordova.md) guide. Non-Ionic applications use their own
lifecycle notifications and do not install this adapter.

The `/ionic` entry point provides shared framework integration. It observes Ionic
overlays and determines which registered surfaces they cover. A plugin's explicit
presentation controls remain part of that plugin's API, connected through
[projection notifications](events.md) or its existing
[renderer API](../advanced/renderer.md).

For example, opening an Ionic settings modal should cover the background native
tab bar while leaving the modal's own native close button usable. A blanket hide
notification cannot express that relationship. The shared monitor evaluates each
host against the overlay stack, so independent plugins use the same coverage rule.

## Enable once

For an Ionic application, call this once during application startup. When calling it directly from the application, install `@webview-native-ui/engine` as a direct application dependency:

```ts
import { enableSupportIonicOverlays } from '@webview-native-ui/engine/ionic';

enableSupportIonicOverlays();
```

Plugin maintainers can include this snippet in their application setup instructions, or call it inside an existing JS initializer. `@rdlabo/capacitor-native-ui` already calls the same initializer internally; its users need no additional call. Non-Ionic applications omit it. Native registration alone does not install Ionic event listeners.

## Coverage and lifetime

One monitor is shared per document, including between the npm module and the runtime injected by Swift/Android. Repeated initialization does not add listeners or erase explicit configuration. Destroying one projection removes only its subscription; it does not stop the monitor used by other plugins. The monitor lives with the document.

The default covers Modal, Popover, Alert, Action Sheet, Loading, Picker, Toast and Menu lifecycle events. It compares each projection's DOM with the active overlay stack: content inside the front modal stays native, while covered content temporarily uses its prepared image. Toasts and inactive sheet backdrops do not cover a surface. Nested overlays keep it covered until the remaining stack permits restoration. Missing images retain the normal Web fallback. This temporary coverage never overwrites a plugin's explicit `web` or `none` destination. Projections registered later read the current state.

Here, Alert means Ionic's `ion-alert`. This adapter does not intercept
`window.alert()`, detect HTML `<dialog>` automatically, or observe native dialogs.
Custom Web overlays can supply lifecycle events through `additional`, below.

A popover displayed in a native window is different from a popover rendered in
the WebView: its DOM placeholder must not be treated as a covering Web overlay.
The `@rdlabo/capacitor-native-ui` plugin reports this native presentation ownership
to the monitor. If its native presentation fails, it releases that ownership and
the monitor resumes ordinary Web overlay coverage. This exception depends on an
explicit integration; it is not inferred from the popover's DOM alone.

## Customize unusual layouts

Optional settings are document-wide. Keep the defaults for ordinary Ionic overlays.
`IonicOverlayOptions`, exported from the same `/ionic` entry point, is the TypeScript
type for these settings; it is not another initialization function.
Use `exclude` for an application overlay that should not cover native content, and
`additional` when the same app also uses a custom dialog with its own lifecycle
events. Use `covers` only when DOM containment and backdrop state do not describe
which hosts that custom layout actually covers:

```ts
enableSupportIonicOverlays({
  exclude: '[data-nonblocking-overlay]',
  additional: [
    {
      selector: 'app-dialog',
      events: {
        willPresent: 'appDialogWillPresent',
        didDismiss: 'appDialogDidDismiss',
      },
    },
  ],
});
```

Use `covers(overlay, target)` only when a registered DOM projection needs a custom coverage rule; return `undefined` for the default, or a boolean to override it. Exclusions and explicit native-window ownership take precedence. The standard relationship uses overlay order, DOM containment and backdrop state, rather than attempting to interpret arbitrary CSS stacking contexts. Configure unusual layouts explicitly.

## When a plugin needs to know which modal is behind another

For ordinary application setup, use `enableSupportIonicOverlays()` as shown above.
The Engine then handles Ionic overlay coverage without additional calls.

A plugin that places native controls inside Ionic modals may also need to know
which modal lies behind the one being opened. Two helpers from the same `/ionic`
entry point let the plugin read the modal order already tracked by the Engine.

For example, open modal A, then modal B above it:

- `ionicModalStack(document)` returns `[A, B]`, from back to front.
- `coveredIonicSurface(B)` returns A, the modal beneath B.
- If a popover opens above B, `coveredIonicSurface(popover)` returns B.
- `coveredIonicSurface(A)` returns `undefined`: the page behind A is not a modal.

A and B here are the actual `ion-modal` DOM elements. These helpers only read the
tracked modal order; they do not open or close overlays, switch projection, or
start monitoring. Call them after `enableSupportIonicOverlays()` has enabled the
monitor and the relevant overlay has entered its presentation lifecycle.
