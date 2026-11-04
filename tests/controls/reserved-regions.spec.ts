import { beforeEach, expect, test, vi } from 'vitest';
import { createNativeUI } from '../../src/controls/startup';
import { resolveVerticalBarsLayout } from '../../src/integration/index';
import { reservedVerticalBarBoundary } from '../../src/integration/reserved-regions';
import type { NativeUIReservedRegion, NativeUIRuntimeHandle, NativeUITransport } from '../../src/controls/index';

const { activate } = vi.hoisted(() => ({ activate: vi.fn() }));
vi.mock('../../src/controls/activation', () => ({
  createNativeUIActivation: () => ({ enableNativeUI: activate, configureNativeTransition: vi.fn() }),
}));

const region = (height: number): NativeUIReservedRegion => ({
  kind: 'occlusion',
  isActive: true,
  x: 382,
  y: 0,
  width: 84,
  height,
  margins: { top: 0, right: 0, bottom: 20, left: 0 },
});
const top = (regions?: readonly NativeUIReservedRegion[]) => reservedVerticalBarBoundary(regions, 'right', 466, 678);

beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  const runtime: NativeUIRuntimeHandle = {
    markForCheck: vi.fn(),
    getStatus: () => ({ state: 'native', projected: 0, updates: 0 }),
    suspend: vi.fn(async () => ({ resume: vi.fn(async () => {}) })),
    destroy: vi.fn(async () => {}),
  };
  activate.mockResolvedValue(runtime);
});

test('external regions leave defaults unset and preserve smaller future-device dimensions without adding margins twice', () => {
  expect(top()).toBeUndefined();
  expect(top([])).toBeUndefined();
  expect(top([region(174)])).toBe(174);
  expect(top([region(120)])).toBe(120);
  expect(top([region(230)])).toBe(230);
});

test('inactive regions, hinges, bottom cameras and invalid geometry do not replace the top rail reservation', () => {
  const irrelevant = [
    { ...region(300), isActive: false },
    { ...region(678), kind: 'division' as const },
    { ...region(78), y: 600 },
    { ...region(37), x: 400, y: 29, width: 37 },
    { ...region(200), height: Number.NaN },
  ];
  expect(top(irrelevant)).toBeUndefined();
  expect(top([...irrelevant, region(174)])).toBe(174);
  expect(reservedVerticalBarBoundary([{ ...region(230), x: 0, width: 100 }], 'left', 600, 800)).toBe(230);
  expect(reservedVerticalBarBoundary([region(174)], 'left', 466, 678)).toBeUndefined();
});

test('the public receiver copies geometry, updates the running shell and clears supplied geometry without restarting', async () => {
  const api = createNativeUI({} as NativeUITransport);
  const input = [region(174)];
  const handle = await api.enableNativeUI({ verticalBars: { reservedRegions: input } });
  const options = activate.mock.calls[0][0];
  input[0].height = 999;
  expect(top(options.verticalBars.reservedRegions)).toBe(174);
  const changed = vi.fn();
  window.addEventListener('nativeUIRefresh', changed);
  try {
    const received = [region(230)];
    handle.setReservedRegions(received);
    received[0].height = 999;
    expect(top(options.verticalBars.reservedRegions)).toBe(230);
    handle.setReservedRegions();
    expect(top(options.verticalBars.reservedRegions)).toBeUndefined();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
    await handle.destroy();
    handle.setReservedRegions([region(300)]);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener('nativeUIRefresh', changed);
    await handle.destroy();
  }
});

test('placement toggles and repeated startup preserve the public region receiver', async () => {
  const api = createNativeUI({} as NativeUITransport);
  const handle = await api.enableNativeUI();
  try {
    await handle.disableVerticalControlArea();
    handle.setReservedRegions([region(174)]);
    await handle.enableVerticalControlArea();
    const same = await api.enableNativeUI({ verticalBars: { reservedRegions: [region(230)] } });
    expect(same).toBe(handle);
    expect(top(activate.mock.calls[0][0].verticalBars.reservedRegions)).toBe(230);
  } finally {
    await handle.destroy();
  }
});

test('device metrics combine placement and active regions without supplying Web defaults', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 466 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 678 });
  const source = {
    getBarPlacement: vi.fn(async () => ({ verticalBarEdge: 'trailing' as const, inset: 84 })),
    getReservedRegions: vi.fn(async () => ({ regions: [region(174)] })),
  };
  expect(await resolveVerticalBarsLayout(source)).toEqual({
    edge: 'trailing',
    inset: 84,
    toolbarTop: 174,
    reservedRegions: [region(174)],
  });
  expect(source.getBarPlacement).toHaveBeenCalledTimes(1);
  expect(source.getReservedRegions).toHaveBeenCalledTimes(1);
  source.getReservedRegions.mockResolvedValue({ regions: [] });
  expect((await resolveVerticalBarsLayout(source)).toolbarTop).toBeUndefined();
});

test('missing, rejected and synchronously throwing device APIs leave defaults to the applying layout', async () => {
  expect(await resolveVerticalBarsLayout({})).toEqual({ edge: undefined, inset: undefined, reservedRegions: undefined });
  const metrics = await resolveVerticalBarsLayout({
    getBarPlacement: async () => ({ verticalBarEdge: 'trailing', inset: 80 }),
    getReservedRegions: () => {
      throw new Error('Unavailable');
    },
  });
  expect(metrics).toEqual({ edge: 'trailing', inset: 80, toolbarTop: undefined, reservedRegions: undefined });
  expect(
    await resolveVerticalBarsLayout({
      getBarPlacement: async () => {
        throw new Error('Unavailable');
      },
      getReservedRegions: async () => ({ regions: [region(174)] }),
    }),
  ).toEqual({ edge: undefined, inset: undefined, reservedRegions: [region(174)] });
});

test('logical placement resolves the physical occlusion in RTL and respects a horizontal device layout', async () => {
  document.documentElement.dir = 'rtl';
  try {
    const metrics = await resolveVerticalBarsLayout({
      getBarPlacement: async () => ({ verticalBarEdge: 'trailing', inset: 84 }),
      getReservedRegions: async () => ({ regions: [{ ...region(230), x: 0 }] }),
    });
    expect(metrics.toolbarTop).toBe(230);
    const horizontal = await resolveVerticalBarsLayout({
      getBarPlacement: async () => ({ verticalBarEdge: null, inset: 0 }),
      getReservedRegions: async () => ({ regions: [region(174)] }),
    });
    expect(horizontal.edge).toBeNull();
    expect(horizontal.toolbarTop).toBeUndefined();
  } finally {
    document.documentElement.removeAttribute('dir');
  }
});
