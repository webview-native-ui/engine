import { observeVerticalBarsModals, movingModal, modalMotionEvent } from '../../src/controls/shared/modal';
import { afterEach, expect, test, vi } from 'vitest';
import { coverOverlayBackground, usesCoveredBackground } from '../../src/controls/overlays/covered-overlay';
import type { CoveredSnapshots } from '../../src/controls/shared/covered-snapshot';

afterEach(() => document.body.replaceChildren());
test('presentation never waits for the bridge or changes Ionic visibility/animation', () => {
  const modal = document.createElement('ion-modal');
  document.body.append(modal);
  const begin = vi.fn(() => new Promise<void>(() => {}));
  const builder = vi.fn();
  const snapshots = { begin, retireRestoration: vi.fn() } as unknown as CoveredSnapshots;
  document.addEventListener('ionModalWillPresent', () => coverOverlayBackground(modal, snapshots), { capture: true, once: true });
  modal.addEventListener('ionModalWillPresent', () => {
    modal.enterAnimation = builder;
  });
  modal.dispatchEvent(new Event('ionModalWillPresent', { bubbles: true }));
  expect(begin).toHaveBeenCalledOnce();
  expect(modal.style.visibility).toBe('');
  expect(modal.enterAnimation).toBe(builder);
});
test.each(['interactive', 'no-backdrop'])('%s modal keeps its live Web background', (kind) => {
  const modal = document.createElement('ion-modal');
  if (kind === 'interactive') {
    modal.initialBreakpoint = 0.5;
    modal.backdropBreakpoint = 0.75;
  }
  if (kind === 'no-backdrop') modal.showBackdrop = false;
  const begin = vi.fn();
  const retireRestoration = vi.fn();
  coverOverlayBackground(modal, { begin, retireRestoration } as unknown as CoveredSnapshots);
  expect(retireRestoration).toHaveBeenCalledOnce();
  expect(begin).not.toHaveBeenCalled();
});

test.each(['sheet', 'card'])('%s motion spans dragging and settling, without treating a tap as movement', async (kind) => {
  vi.useFakeTimers();
  document.body.innerHTML = '<ion-app class="ios-theme-vertical-bars"><ion-modal></ion-modal></ion-app>';
  const modal = document.querySelector('ion-modal')!;
  if (kind === 'sheet') modal.breakpoints = [0, 0.5, 0.8];
  else modal.presentingElement = document.body;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('part', 'content');
  modal.attachShadow({ mode: 'open' }).append(wrapper);
  let y = 136;
  let running = false;
  wrapper.getBoundingClientRect = () => DOMRect.fromRect({ y, width: innerWidth, height: innerHeight });
  wrapper.getAnimations = () => (running ? [{ playState: 'running' } as Animation] : []);
  Object.defineProperty(wrapper, 'offsetWidth', { value: innerWidth });
  const events: boolean[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent).detail.moving);
    if (!(event as CustomEvent).detail.moving)
      expect(modal.style.getPropertyValue('--ios-theme-vertical-bars-modal-offset-top')).toBe(`${y}px`);
  };
  window.addEventListener(modalMotionEvent, listener);
  const stop = observeVerticalBarsModals(document);
  try {
    modal.dispatchEvent(new CustomEvent('ionModalDidPresent', { bubbles: true }));
    modal.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    modal.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    expect(movingModal(document)).toBeUndefined();
    y = 200;
    await vi.advanceTimersByTimeAsync(20);
    expect(movingModal(document)).toBe(modal);
    y = 300;
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual([true]);
    modal.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(40);
    expect(movingModal(document)).toBe(modal);
    expect(events).toEqual([true]);
    running = true;
    modal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    modal.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    expect(movingModal(document)).toBe(modal);
    running = false;
    y = 136;
    vi.advanceTimersToNextFrame();
    expect(movingModal(document)).toBe(modal);
    vi.advanceTimersToNextFrame();
    expect(events).toEqual([true, false]);
    expect(movingModal(document)).toBeUndefined();
  } finally {
    stop();
    window.removeEventListener(modalMotionEvent, listener);
    vi.useRealTimers();
  }
});

test.each(['popover', 'alert', 'action-sheet', 'loading', 'picker'])('%s shares the blocking background handoff', (name) => {
  const overlay = document.createElement(`ion-${name}`);
  const snapshots = { begin: vi.fn(), retireRestoration: vi.fn() } as unknown as CoveredSnapshots;
  coverOverlayBackground(overlay, snapshots);
  expect(snapshots.begin).toHaveBeenCalledOnce();
  Object.assign(overlay, { showBackdrop: false });
  expect(usesCoveredBackground(overlay)).toBe(false);
});
test.each(['toast', 'menu'])('%s keeps its existing live route', (name) => {
  expect(usesCoveredBackground(document.createElement(`ion-${name}`))).toBe(false);
});

test('card modal uses the same prepared background handoff', () => {
  const modal = document.createElement('ion-modal');
  modal.presentingElement = document.body;
  const snapshots = { begin: vi.fn(), retireRestoration: vi.fn() } as unknown as CoveredSnapshots;
  coverOverlayBackground(modal, snapshots);
  expect(snapshots.begin).toHaveBeenCalledWith(document.body);
});

test.each([
  ['outer portrait right', 466, 8, 450, false, 84, true],
  ['outer landscape left', 678, 8, 662, true, 84, true],
  ['inner floating right', 951, 149, 653, false, 84, false],
  ['inner floating left', 951, 149, 653, true, 84, false],
  ['touching right boundary', 951, 214, 653, false, 84, false],
  ['touching left boundary', 951, 84, 653, true, 84, false],
  ['no side inset', 466, 8, 450, false, 0, false],
] as const)('%s selects the rail using logical dialog bounds', async (_name, viewport, x, width, left, inset, expected) => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', viewport);
  document.body.innerHTML = '<ion-app class="ios-theme-vertical-bars"><ion-modal></ion-modal></ion-app>';
  const app = document.querySelector('ion-app')!;
  if (left) app.classList.add('ios-theme-vertical-bars-left');
  app.style.setProperty(`--ios-theme-vertical-bars-safe-area-${left ? 'left' : 'right'}-resolved`, `${inset}px`);
  // An explicit zero must override the legacy native inset.
  app.style.setProperty('--ios-theme-vertical-bars-native-inset', '84px');
  const modal = document.querySelector('ion-modal')!;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('part', 'content');
  modal.attachShadow({ mode: 'open' }).append(wrapper);
  Object.defineProperties(wrapper, { offsetLeft: { value: x }, offsetWidth: { value: width } });
  wrapper.getAnimations = () => [];
  // Presentation transforms must not change rail eligibility.
  wrapper.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 8, width: 100, height: 300 });
  const stop = observeVerticalBarsModals(document);
  try {
    modal.dispatchEvent(new CustomEvent('ionModalDidPresent', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(40);
    expect(modal.classList.contains('ios-theme-vertical-bars-modal')).toBe(expected);
    app.classList.remove('ios-theme-vertical-bars');
    await vi.advanceTimersByTimeAsync(40);
    expect(modal.classList.contains('ios-theme-vertical-bars-modal')).toBe(false);
  } finally {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
