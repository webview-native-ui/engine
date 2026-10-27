/** Image presentation only; Native/Web ownership styling stays with the renderer. */
export const snapshotStyles = `
:is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared]),
:is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared]) *,
:is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared])::before,
:is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared])::after,
:is([data-native-ui-snapshot-source], [data-native-ui-snapshot-prepared])::part(native) { visibility: hidden !important; }
`;
