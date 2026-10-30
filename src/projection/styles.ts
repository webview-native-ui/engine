/*!
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

/** Image presentation only; Native/Web ownership styling stays with the renderer. */
const hidden = ':is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared], [data-native-ui-snapshot-content])';

export const snapshotStyles = `
@layer native-ui-projection {
${hidden}, ${hidden} *, ${hidden}::part(native) { visibility: hidden !important; }
${hidden}::before, ${hidden}::after,
${hidden} *::before, ${hidden} *::after {
  visibility: hidden !important;
}
}
[data-native-ui-snapshot-visible] { opacity:1!important;overflow:visible!important; }
[data-native-ui-snapshot-visible][data-native-ui-snapshot-positioned] { position:relative!important; }
`;

export const snapshotShadowStyles = `
@layer native-ui-projection {
:host([data-native-ui-snapshot-content]),
:host([data-native-ui-snapshot-content])::before,
:host([data-native-ui-snapshot-content])::after,
:host([data-native-ui-snapshot-content]) *,
:host([data-native-ui-snapshot-content]) *::before,
:host([data-native-ui-snapshot-content]) *::after {
  visibility: hidden !important;
}
}
`;
