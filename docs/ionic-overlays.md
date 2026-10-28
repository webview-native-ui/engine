# Cover native UI with Ionic overlays

Use this adapter when an Ionic modal or another covering Web overlay should appear
above Engine-managed native content. Native registration handles capture and
restoration, but it cannot infer Ionic's presentation lifecycle from a native
view. This shared monitor supplies that coverage decision for all registrations.

Integrate the plugin through the [Capacitor](capacitor-plugin.md) or
[Cordova](cordova-plugin.md) guide first. Non-Ionic applications use their own
lifecycle notifications and do not install this adapter.

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

Native Popover ownership is supplied by the Native UI vertical-bars renderer. The shared monitor does not treat its source DOM as a covering Web overlay. If native presentation fails, the renderer releases ownership and normal DOM coverage resumes.

## Customize unusual layouts

Optional settings are document-wide:

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
