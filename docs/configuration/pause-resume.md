# Cover native UI with a custom Web overlay

Use `pause()` before presenting a custom modal or `div` over native UI and
`resume()` when it closes. For Ionic overlays, use the automatic
[Ionic integration](ionic-overlays.md), which shares this coordination but only
covers surfaces behind the overlay.

## Plugin authors: re-export the Engine functions

```ts
export { pause, resume } from '@webview-native-ui/engine';
```

The functions share one pause count across Engine-enabled plugins and bundles in
the same document. No wrapper or native plugin method is needed.

## Application authors: pair each pause with a resume

```ts
import { pause, resume } from 'your-plugin';

pause();
try {
  await showCustomModal();
} finally {
  resume();
}
```

`showCustomModal()` must resolve when the modal closes. With event-driven modals,
call `resume()` on dismissal, cancellation or failure. Use one pair per overlay,
even with multiple plugins; nested overlays each need their own pair.

A pause replaces visible native surfaces with prepared Web images or their normal
Web fallback. Hidden surfaces stay hidden. The final matching `resume()` releases
the request, preserving each plugin's presentation intent and remaining Ionic
overlay coverage. An extra `resume()` at zero has no effect.

Both functions return immediately, without waiting for native acknowledgments or
painting. Calling `pause()` just before a blocking `window.alert()` therefore does
not guarantee a completed handoff. They do not detect custom overlays automatically.
