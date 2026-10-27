export type ProjectionImagePlacement = 'previous' | 'child';

/** A fixed Web fallback element. A replacement element requires a new scope. */
export const createWebProjectionScope = (
  element: HTMLElement,
  namespace: string,
  options: { imagePlacement?: ProjectionImagePlacement } = {},
) => {
  const imagePlacement = options.imagePlacement ?? 'previous';
  if (imagePlacement !== 'previous' && imagePlacement !== 'child') throw new TypeError('imagePlacement must be previous or child');
  if (element.nodeType !== 1 || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !element.ownerDocument || !('style' in element))
    throw new TypeError('A Web projection scope requires an HTMLElement fallback');
  if (
    element.matches(
      'img, input, textarea, select, video, audio, canvas, iframe, embed, object, br, hr, area, base, link, meta, source, track, wbr',
    )
  )
    throw new TypeError('A Web projection fallback must be a container element; use the existing fallback container');
  return Object.freeze({ element, namespace, imagePlacement });
};
export type WebProjectionScope = ReturnType<typeof createWebProjectionScope>;
