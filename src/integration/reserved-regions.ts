import type { Frame } from '../types.js';

/** Viewport CSS-pixel geometry supplied by the application, independent of a device SDK. */
export interface NativeUIReservedRegion extends Frame {
  kind: 'division' | 'occlusion';
  isActive: boolean;
  /** Already included in the frame. Never add these to the occlusion boundary again. */
  margins?: { top: number; right: number; bottom: number; left: number };
}

/** OS frames include their margins. Only the active top reservation on the rail
 * contributes; cameras below the toolbar and hinge divisions do not move it. */
export const reservedVerticalBarBoundary = (
  regions: readonly NativeUIReservedRegion[] | undefined,
  edge: 'left' | 'right',
  width: number,
  height: number,
): number | undefined => {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  const bottoms = (regions ?? []).flatMap((region) => {
    const { x, y, width: w, height: h } = region;
    if (
      region.kind !== 'occlusion' ||
      !region.isActive ||
      ![x, y, w, h].every(Number.isFinite) ||
      w <= 0 ||
      h <= 0 ||
      y > 0 ||
      y + h <= 0 ||
      (edge === 'right' ? x >= width || x + w < width : x > 0 || x + w <= 0)
    )
      return [];
    return [Math.min(y + h, height)];
  });
  return bottoms.length ? Math.max(...bottoms) : undefined;
};
