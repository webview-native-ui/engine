import { expect, test } from 'vitest';
import { reservedVerticalBarBoundary, type NativeUIReservedRegion } from '../../src/integration/reserved-regions';

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

test('external regions leave defaults unset and preserve smaller future-device dimensions without adding margins twice', () => {
  expect(top()).toBeUndefined();
  expect(top([])).toBeUndefined();
  expect(reservedVerticalBarBoundary([region(174)], 'right', Number.NaN, 678)).toBeUndefined();
  expect(reservedVerticalBarBoundary([region(174)], 'right', 466, 0)).toBeUndefined();
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
