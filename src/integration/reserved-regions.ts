import type { Frame } from '../types.js';

/** Viewport CSS-pixel geometry supplied by the application, compatible with capacitor-foldable. */
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

/** Structural source: no dependency on a specific device plugin. */
export interface VerticalBarsLayoutProvider {
  getBarPlacement?(): Promise<{ verticalBarEdge: 'leading' | 'trailing' | null; inset: number }>;
  getReservedRegions?(): Promise<{ regions: readonly NativeUIReservedRegion[] }>;
}

export interface ResolvedVerticalBarsLayout {
  edge?: 'leading' | 'trailing' | null;
  inset?: number;
  toolbarTop?: number;
  reservedRegions?: readonly NativeUIReservedRegion[];
}

/** Read one device snapshot. Missing values retain the applying layout's defaults. */
export const resolveVerticalBarsLayout = async (provider: VerticalBarsLayoutProvider): Promise<ResolvedVerticalBarsLayout> => {
  const [placement, reserved] = await Promise.allSettled([
    Promise.resolve().then(() => provider.getBarPlacement?.()),
    Promise.resolve().then(() => provider.getReservedRegions?.()),
  ]);
  const bars = placement.status === 'fulfilled' ? placement.value : undefined;
  const regions = reserved.status === 'fulfilled' ? reserved.value?.regions : undefined;
  const edge = bars?.verticalBarEdge;
  const metrics: ResolvedVerticalBarsLayout = {
    edge,
    inset: Number.isFinite(bars?.inset) && bars!.inset >= 0 ? bars!.inset : undefined,
    reservedRegions: regions?.map((region) => ({ ...region })),
  };
  if (edge && typeof window !== 'undefined') {
    const root = document.querySelector('ion-app') ?? document.documentElement;
    const rtl = root.closest('[dir]')?.getAttribute('dir') === 'rtl';
    const physicalEdge = (edge === 'leading') !== rtl ? 'left' : 'right';
    metrics.toolbarTop = reservedVerticalBarBoundary(regions, physicalEdge, window.innerWidth, window.innerHeight);
  }
  return metrics;
};
