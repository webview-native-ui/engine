# Cover native UI with Ionic overlays

Use this adapter when an Ionic modal or another covering Web overlay should appear
above Engine-managed native content. Native registration handles capture and
restoration, but it cannot infer Ionic's presentation lifecycle from a native
view. This shared monitor supplies that coverage decision for all registrations.

Integrate the plugin through the [Capacitor](../getting-started/capacitor.md) or
[Cordova](../getting-started/cordova.md) guide first. Non-Ionic applications use their own
lifecycle notifications and do not install this adapter. Standard HTML dialogs opened
with `showModal()` are detected automatically on WebViews supporting `:modal`, without
this initializer or custom events. Closing or removing the dialog restores coverage.

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

A popover displayed in a native window is different from a popover rendered in
the WebView: its DOM placeholder must not be treated as a covering Web overlay.
The `@rdlabo/capacitor-native-ui` plugin reports this native presentation ownership
to the monitor. If its native presentation fails, it releases that ownership and
the monitor resumes ordinary Web overlay coverage. This exception depends on an
explicit integration; it is not inferred from the popover's DOM alone.

## Customize unusual layouts

Optional settings are document-wide. Keep the defaults for ordinary Ionic overlays.
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
