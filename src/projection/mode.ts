const key = Symbol.for('@webview-native-ui/engine/projection-request/v1');

/** Shared application request, not an aggregate of the surfaces' current presentation. */
export const getProjectionRequest = (doc: Document) => {
  const shared = doc as unknown as Record<symbol, { webRequested: boolean; listeners: Set<() => void> }>;
  return (shared[key] ??= { webRequested: false, listeners: new Set() });
};

/** Request Web projection for all Engine surfaces in this document, or release that request.
 * Native mode preserves each surface's own visibility and overlay state.
 * This requests a transition; it does not wait for native drawing acknowledgements.
 */
export const setProjection = (mode: 'native' | 'web'): void => {
  if (mode !== 'native' && mode !== 'web') throw new TypeError('Projection mode must be native or web');
  const request = getProjectionRequest(document);
  const webRequested = mode === 'web';
  if (request.webRequested === webRequested) return;
  request.webRequested = webRequested;
  for (const listener of request.listeners) listener();
};
