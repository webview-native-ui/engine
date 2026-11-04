import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({
  stdin: {
    contents:
      "export { createNativeUI } from './src/controls/startup'; export { movingModal, projectingModal, modalMotionEvent } from './src/controls/shared/modal';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'iife',
  globalName: 'modalMotion',
  write: false,
}).outputFiles[0].text;

const boot = async (page: Page, fixed: number | undefined, initial = 40, theme = true, platform = 'ios') => {
  await page.setContent(`
    <style>
      ion-modal { position:fixed; inset:0;
        ${!theme ? '' : `--ios-theme-vertical-bars-toolbar-top:999px; --ios-theme-vertical-bars-modal-toolbar-top:max(24px,calc(var(--ios-theme-vertical-bars-toolbar-top) - var(--ios-theme-vertical-bars-modal-offset-top,0px)));`}
      }
    </style>
    <ion-app class="ios-theme-vertical-bars"><ion-modal></ion-modal></ion-app>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ y, fixed, platform }) => {
      const w = window as any;
      const modal = document.querySelector('ion-modal')!;
      const content = document.createElement('div');
      content.setAttribute('part', 'content');
      content.style.cssText = `position:absolute;left:0;top:0;width:100vw;height:100vh;transform:translateY(${y}px)`;
      content.append(document.createElement('slot'));
      modal.attachShadow({ mode: 'open' }).append(content);
      w.events = [];
      window.addEventListener(w.modalMotion.modalMotionEvent, (event: any) => w.events.push(event.detail.moving));
      w.regions = (height?: number) =>
        height === undefined
          ? undefined
          : [
              {
                kind: 'occlusion',
                isActive: true,
                x: innerWidth - 84,
                y: 0,
                width: 84,
                height,
                margins: { top: 0, right: 0, bottom: 20, left: 0 },
              },
            ];
      w.api = w.modalMotion.createNativeUI({
        getPlatform: () => platform,
        isAvailable: () => true,
        plugin: {
          configure: async () => ({ supported: true }),
          getWebViewMetrics: async () => ({ radius: 0, verticalBarEdge: 'trailing' }),
          getVerticalBarsGeometry: async () => ({ items: {} }),
          addListener: async () => ({ remove: async () => {} }),
          update: async (snapshot: any) => ({ revision: snapshot.revision }),
          clear: async () => {},
          stopOverlays: async () => {},
        },
      });
      w.ui = await w.api.enableNativeUI({ controls: 'verticalOnly', verticalBars: { reservedRegions: w.regions(fixed) } });
      w.stopModalMotion = () => w.ui.destroy();
      modal.dispatchEvent(new CustomEvent('ionModalDidPresent', { bubbles: true }));
      modal.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    },
    { y: initial, fixed, platform },
  );
};

const move = (page: Page, y: number) =>
  page.evaluate(async (nextY) => {
    const w = window as any;
    const modal = document.querySelector('ion-modal')!;
    const content = modal.shadowRoot!.querySelector<HTMLElement>('[part="content"]')!;
    content.style.transform = `translateY(${nextY}px)`;
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return w.modalMotion.projectingModal(document) === modal;
  }, y);

for (const fixed of [174, 230]) {
  test(`Duo keeps native bars fixed above ${fixed}px and restores them on crossing back during a drag`, async ({ page }) => {
    await boot(page, fixed);
    expect(await move(page, 100)).toBe(false);
    expect(await move(page, fixed - 24)).toBe(false);
    expect(await move(page, fixed - 22)).toBe(true);
    expect(await move(page, fixed + 60)).toBe(true);
    expect(await move(page, fixed - 26)).toBe(false);
    expect(await page.evaluate(() => (window as any).events)).toEqual([true, false]);
    await page.evaluate(() => (window as any).stopModalMotion());
    expect(await page.locator('ion-modal > span').count()).toBe(0);
  });
}

test('a partially open sheet follows until it reaches the fixed region', async ({ page }) => {
  await boot(page, 170, 300);
  expect(await move(page, 280)).toBe(true);
  expect(await move(page, 200)).toBe(true);
  expect(await move(page, 140)).toBe(false);
});

test('a theme without the rail clamp retains the existing motion handoff', async ({ page }) => {
  await boot(page, undefined, 40, false);
  expect(await move(page, 100)).toBe(true);
});

test('external updates replace the boundary and clearing regions restores the fixed fallback', async ({ page }) => {
  await boot(page, 174);
  expect(await move(page, 180)).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    const regions = w.regions(260);
    w.ui.setReservedRegions(regions);
    regions[0].height = 999;
  });
  expect(await move(page, 190)).toBe(false);
  await page.evaluate(() => {
    (window as any).ui.setReservedRegions();
  });
  expect(await move(page, 200)).toBe(true);
  expect(await page.locator('ion-modal').evaluate((modal) => modal.style.getPropertyValue('--ios-theme-vertical-bars-toolbar-top'))).toBe(
    '170px',
  );
  await page.evaluate(() => (window as any).ui.destroy());
  expect(await page.locator('ion-modal').evaluate((modal) => modal.style.getPropertyValue('--ios-theme-vertical-bars-toolbar-top'))).toBe(
    '',
  );
});

test('programmatic dismissal tracks compositor motion after an idle pointer-free modal crosses the OS boundary', async ({ page }) => {
  await boot(page, 174);
  await page.locator('ion-modal').dispatchEvent('pointerup');
  expect(await move(page, 40)).toBe(false);
  expect(await page.evaluate(() => !!(window as any).modalMotion.movingModal(document))).toBe(false);
  await page.evaluate(() => {
    const modal = document.querySelector('ion-modal')!;
    modal.dispatchEvent(new CustomEvent('ionModalWillDismiss', { bubbles: true }));
    // Ionic starts the leave animation after WillDismiss. WAAPI does not mutate
    // style attributes, so the observer must already be tracking this lifecycle.
    const content = modal.shadowRoot!.querySelector<HTMLElement>('[part="content"]')!;
    content.animate([{ transform: 'translateY(40px)' }, { transform: 'translateY(300px)' }], {
      duration: 1200,
      fill: 'forwards',
    });
  });
  expect(await page.evaluate(() => !!(window as any).modalMotion.projectingModal(document))).toBe(false);
  await expect.poll(() => page.evaluate(() => !!(window as any).modalMotion.projectingModal(document))).toBe(true);
  await page.locator('ion-modal').dispatchEvent('ionModalDidDismiss');
  await page.evaluate(() => (window as any).ui.destroy());
});

test('Android preserves its existing motion path with or without supplied rail geometry', async ({ page }) => {
  await boot(page, undefined, 40, true, 'android');
  expect(await move(page, 100)).toBe(true);
  expect(await page.locator('ion-modal').evaluate((modal) => modal.style.getPropertyValue('--ios-theme-vertical-bars-toolbar-top'))).toBe(
    '',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.ui.setReservedRegions(w.regions(174));
  });
  expect(await move(page, 100)).toBe(true);
  expect(await page.locator('ion-modal').evaluate((modal) => modal.style.getPropertyValue('--ios-theme-vertical-bars-toolbar-top'))).toBe(
    '',
  );
  expect(await move(page, 200)).toBe(true);
  await page.evaluate(() => (window as any).ui.destroy());
});
