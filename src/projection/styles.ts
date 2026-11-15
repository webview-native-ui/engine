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

export const imageMarker = 'data-native-ui-snapshot';

/** Own a projection's styles and content markers, including nested shadow trees. */
export const createSnapshotStyles = (doc: Document) => {
  const sheets = new Map<Document | ShadowRoot, HTMLStyleElement>();
  const rootFor = (element: HTMLElement) => {
    const root = element.getRootNode();
    return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot) : doc;
  };
  const sheetFor = (root: Document | ShadowRoot) => {
    if (sheets.has(root)) return;
    const style = doc.createElement('style');
    style.setAttribute('data-native-ui-snapshot-base', '');
    style.textContent = snapshotStyles + (root.nodeType === 11 ? snapshotShadowStyles : '');
    (root.nodeType === 11 ? root : (root as Document).head).append(style);
    sheets.set(root, style);
  };
  // Each shadow tree is a separate style scope. Keep these rules alongside the
  // prepared image; only the marker changes during the handoff.
  const finishVisibilityTransitions = (target: HTMLElement) => {
    // A visibility transition can keep the old content painted over the image.
    // Do not stop layout, transform or opacity transitions owned by the renderer.
    const animations = [
      ...target.getAnimations({ subtree: true }),
      ...[...(shadowHosts.get(target) ?? [])].flatMap((host) => host.shadowRoot?.getAnimations() ?? []),
    ];
    for (const animation of animations)
      if ('transitionProperty' in animation && animation.transitionProperty === 'visibility') animation.cancel();
  };
  const shadowHosts = new Map<HTMLElement, Set<HTMLElement>>();
  const syncShadowContent = (target: HTMLElement) => {
    const hosts = shadowHosts.get(target) ?? new Set<HTMLElement>();
    shadowHosts.set(target, hosts);
    const hidden = target.hasAttribute('data-native-ui-snapshot-source') || target.hasAttribute('data-native-ui-snapshot-prepared');
    const visit = (element: HTMLElement) => {
      if (element.hasAttribute('data-native-ui-projection-node')) return;
      if (element.shadowRoot) {
        hosts.add(element);
        sheetFor(element.shadowRoot);
        for (const child of element.shadowRoot.children) visit(child as HTMLElement);
      }
      for (const child of element.children) visit(child as HTMLElement);
    };
    visit(target);
    for (const host of hosts) host.toggleAttribute('data-native-ui-snapshot-content', hidden);
    finishVisibilityTransitions(target);
  };
  const clearTarget = (target: HTMLElement, ownsPreparedMarker: boolean) => {
    shadowHosts.get(target)?.forEach((host) => host.removeAttribute('data-native-ui-snapshot-content'));
    if (ownsPreparedMarker) target.removeAttribute('data-native-ui-snapshot-prepared');
    target.removeAttribute('data-native-ui-snapshot-visible');
    target.removeAttribute(imageMarker);
    target.removeAttribute('data-native-ui-snapshot-positioned');
    target.removeAttribute('data-native-ui-snapshot-source');
    finishVisibilityTransitions(target);
    shadowHosts.delete(target);
  };
  return {
    ensureSheet: (target: HTMLElement) => sheetFor(rootFor(target)),
    hasSheet: (target: HTMLElement) => sheets.has(rootFor(target)),
    syncContent: syncShadowContent,
    clearTarget,
    pruneSheets(roots: Iterable<Node>) {
      const liveRoots = new Set<Node>([
        ...roots,
        ...[...shadowHosts.values()].flatMap((hosts) => [...hosts].map((host) => host.shadowRoot!)),
      ]);
      for (const [root, sheet] of sheets)
        if (root.nodeType === 11 && !liveRoots.has(root)) {
          sheet.remove();
          sheets.delete(root);
        }
    },
    retireSheets(disposeAll: boolean) {
      sheets.forEach((style, root) => {
        if (disposeAll || (root.nodeType === 11 && !(root as ShadowRoot).host.isConnected)) {
          style.remove();
          sheets.delete(root);
        }
      });
    },
  };
};
