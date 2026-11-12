import { afterEach, expect, test, vi } from 'vitest';
import { createRuntime } from '../../src/controls/runtime';
import { enableSupportIonicOverlays } from '../../src/ionic';
import { getProjectionState } from '../../src/controls/shared/covered-source';
import type { NativeUIPlugin, NativeUIRuntimeHandle, NativeUISnapshot } from '../../src/controls/definitions';
import type { PreparedWebProjection, WebProjectionInteraction, WebProjectionRequest } from '../../src/types';

// This exercises the real runtime and Ionic event monitor, with controlled native
// replies. It cannot establish UIKit/WebKit pixel correctness on a physical device.
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
const originalUrl = window.location.href;
let handle: NativeUIRuntimeHandle | undefined;
let releasePending: (() => void) | undefined;
afterEach(async () => {
  releasePending?.();
  releasePending = undefined;
  await handle?.destroy();
  handle = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  window.history.replaceState(null, '', originalUrl);
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const emit = (target: Element, type: string, detail?: unknown) => target.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
const cases = [0, 1, 4].flatMap((switches) =>
  ['ready', 'transfer', 'decode'].flatMap((stage) =>
    ['none', 'breakpoint', 'unrelated-dismiss', 'dismiss-before-ready'].flatMap((event) =>
      ['dom-tabs', 'angular-lifecycle'].map((route) => ({ switches, stage, event, route })),
    ),
  ),
);

test.each(cases)('$route overlay after $switches tab switches: $stage / $event', async ({ switches, stage, event, route }) => {
  document.body.innerHTML = `<ion-app><ion-tabs>${['a', 'b']
    .map(
      (tab, index) =>
        `<main id="${tab}" class="ion-page ${index ? 'ion-page-hidden' : ''}"><ion-header><ion-toolbar>
    <button data-native-ui="button" slot="end">${tab} Publish</button>
    <button data-native-ui="button" slot="end">${tab} More</button>
    </ion-toolbar></ion-header></main>`,
    )
    .join(
      '',
    )}<ion-tab-bar><ion-tab-button tab="a" href="/tabs/a"></ion-tab-button><ion-tab-button tab="b" href="/tabs/b"></ion-tab-button></ion-tab-bar></ion-tabs></ion-app>`;
  window.history.replaceState(null, '', '/tabs/a');
  const bar = document.querySelector('ion-tab-bar')!;
  Object.assign(bar, { selectedTab: 'a' });
  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    Object.assign(element.style, { visibility: 'visible', opacity: '1', transform: 'none', fontSize: '16px', color: 'rgb(0,0,0)' });
    element.getBoundingClientRect = () => DOMRect.fromRect({ x: 10, y: 10, width: 80, height: 44 });
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('Capacitor', { convertFileSrc: (url: string) => url });
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as MediaQueryList);
  let decodeBlocked = false;
  const decodes: (() => void)[] = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: vi.fn(() => (decodeBlocked ? new Promise<void>((resolve) => decodes.push(resolve)) : Promise.resolve())),
  });
  const requests: WebProjectionRequest[] = [];
  const snapshots: NativeUISnapshot[] = [];
  let interaction: (event: WebProjectionInteraction) => void = () => {};
  let transferBlocked = false;
  const transfers: (() => void)[] = [];
  releasePending = () => {
    transferBlocked = false;
    decodeBlocked = false;
    transfers.splice(0).forEach((resolve) => resolve());
    decodes.splice(0).forEach((resolve) => resolve());
  };
  let serial = 0;
  const plugin = {
    addListener: async (name: string, listener: (event: WebProjectionInteraction) => void) => {
      if (name === 'snapshotInteraction') interaction = listener;
      return { remove: async () => {} };
    },
    update: async (snapshot: NativeUISnapshot) => {
      snapshots.push(snapshot);
      return { revision: snapshot.revision };
    },
    clear: async () => {},
    coveredSnapshot: async (request: WebProjectionRequest) => {
      requests.push(request);
      if (request.action !== 'prepare') return { shown: true };
      const result: PreparedWebProjection = {
        token: `capture-${++serial}`,
        parts: request.ids.map((id, index) => ({
          ids: [id],
          url: `file:///capture-${serial}-${index}.png`,
          x: 10,
          y: 10,
          width: 80,
          height: 44,
        })),
      };
      if (transferBlocked) await new Promise<void>((resolve) => transfers.push(resolve));
      return result;
    },
  } as unknown as NativeUIPlugin;
  enableSupportIonicOverlays();
  handle = await createRuntime(document, plugin, { source: 'html', coveredSnapshots: true });
  interaction({ active: false, capturePolicy: 'preinteraction' });
  await vi.waitFor(() =>
    expect(getProjectionState(document).preparedOwners.length, JSON.stringify({ requests, snapshots: snapshots.length })).toBeGreaterThan(
      0,
    ),
  );
  interaction({ active: false, capturePolicy: 'preinteraction' });
  const tabs = document.querySelector('ion-tabs')!;
  let active = document.querySelector<HTMLElement>('#a')!;
  await settle();
  let before = requests.length;
  for (let i = 0; i < switches; i++) {
    if (i === switches - 1) {
      before = requests.length;
      transferBlocked = stage === 'transfer';
      decodeBlocked = stage === 'decode';
    }
    const next = document.querySelector<HTMLElement>(active.id === 'a' ? '#b' : '#a')!;
    window.history.replaceState(null, '', `/tabs/${next.id}`);
    if (route === 'dom-tabs') emit(tabs, 'ionTabsWillChange', { tab: next.id });
    emit(active, 'ionViewWillLeave');
    emit(next, 'ionViewWillEnter');
    active.classList.add('ion-page-hidden');
    next.classList.remove('ion-page-hidden');
    emit(active, 'ionViewDidLeave');
    emit(next, 'ionViewDidEnter');
    Object.assign(bar, { selectedTab: next.id });
    if (route === 'dom-tabs') emit(tabs, 'ionTabsDidChange', { tab: next.id });
    active = next;
    // Intermediate visits settle; the final visit is observed at a specific
    // handoff stage, rather than relying on a machine-dependent sleep race.
    if (i < switches - 1) await settle();
  }
  if (switches === 0) {
    transferBlocked = stage === 'transfer';
    decodeBlocked = stage === 'decode';
  }
  // A DOM change also makes the zero-switch case request a fresh capture.
  if (switches === 0) active.querySelector('button')!.textContent += ' updated';
  await vi.waitFor(() => expect(requests.slice(before).some((r) => r.action === 'prepare')).toBe(true));
  // Drain the tab's reconciliation frames while the selected native/decode gate
  // stays closed; pinning an already superseded request is not a native contact.
  await settle();
  if (stage === 'decode') await vi.waitFor(() => expect(decodes.length).toBeGreaterThan(0));
  const request = requests.filter((r): r is Extract<WebProjectionRequest, { action: 'prepare' }> => r.action === 'prepare').at(-1)!;
  interaction({ active: false, capturePolicy: 'preinteraction' });
  interaction({ active: true, captureID: request.captureID, captureOwner: request.captureOwner, captureState: 'processing' });
  const modal = document.createElement('ion-modal');
  Object.assign(modal, { initialBreakpoint: 0.6, backdropBreakpoint: 0 });
  document.querySelector('ion-app')!.append(modal);
  emit(modal, 'ionModalWillPresent');
  if (event === 'breakpoint') emit(modal, 'ionBreakpointDidChange', { breakpoint: 0.6 });
  if (event === 'unrelated-dismiss') {
    const toast = document.createElement('ion-toast');
    document.body.append(toast);
    emit(toast, 'ionToastDidDismiss');
    toast.remove();
  }
  if (event === 'dismiss-before-ready') {
    interaction({ active: false });
    emit(modal, 'ionModalWillDismiss');
    emit(modal, 'ionModalDidDismiss');
    modal.remove();
    releasePending();
    await settle();
    expect([...active.querySelectorAll('button')].some((button) => getProjectionState(document).isVisible(button))).toBe(false);
    expect(snapshots.at(-1)?.controls.length).toBe(2);
    return;
  }
  releasePending();
  emit(modal, 'ionModalDidPresent');
  await settle();
  const state = getProjectionState(document);
  const buttons = [...active.querySelectorAll('button')];
  const evidence = {
    route,
    switches,
    stage,
    event,
    actions: requests.slice(before).map((r) => r.action),
    nativeControls: snapshots.at(-1)?.controls.length,
    visibleOwners: buttons.map((button) => state.isVisible(button)),
    imageOpacity: [...active.querySelectorAll<HTMLImageElement>('img[data-native-ui-projection-image]')].map((img) => img.style.opacity),
  };
  // A cover request alone is not success: both toolbar sources must own visible
  // fallback images after the transport and decode queues have drained.
  expect(
    buttons.every((button) => state.isVisible(button)),
    JSON.stringify(evidence),
  ).toBe(true);
  expect(evidence.imageOpacity.length, JSON.stringify(evidence)).toBeGreaterThanOrEqual(2);
  expect(
    evidence.imageOpacity.every((opacity) => opacity === '1'),
    JSON.stringify(evidence),
  ).toBe(true);

  interaction({ active: false });
  emit(modal, 'ionModalWillDismiss');
  emit(modal, 'ionModalDidDismiss');
  modal.remove();
  await settle();
  expect(buttons.some((button) => state.isVisible(button))).toBe(false);
  expect(snapshots.at(-1)?.controls.length).toBe(2);

  // A surviving request must not poison the next presentation or leave native
  // controls hidden after dismissal.
  const nextCapture = requests.filter((r): r is Extract<WebProjectionRequest, { action: 'prepare' }> => r.action === 'prepare').at(-1)!;
  interaction({ active: true, captureID: nextCapture.captureID, captureOwner: nextCapture.captureOwner, captureState: 'processing' });
  document.querySelector('ion-app')!.append(modal);
  emit(modal, 'ionModalWillPresent');
  emit(modal, 'ionModalDidPresent');
  await settle();
  expect(buttons.every((button) => state.isVisible(button))).toBe(true);
});
