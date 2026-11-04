import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({
  stdin: { contents: "export { createNativeUI } from './src/controls/startup';", resolveDir: process.cwd() },
  bundle: true,
  format: 'iife',
  globalName: 'nativeRuntime',
  write: false,
}).outputFiles[0].text;

const boot = async (page: Page, snapshots = true) => {
  await page.setContent(`<style>
    ion-modal {position:fixed;inset:0;--ios-theme-vertical-bars-modal-toolbar-top:max(24px,calc(var(--ios-theme-vertical-bars-toolbar-top) - var(--ios-theme-vertical-bars-modal-offset-top,0px)))}
    button {position:absolute;right:24px;top:134px;width:48px;height:48px}
  </style><ion-app class="ios-theme-vertical-bars"><ion-modal><button data-native-ui="button" data-native-ui-placement="rail">Close</button></ion-modal></ion-app>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async (snapshots) => {
    const w = window as any;
    w.updates = [];
    w.calls = [];
    w.Capacitor = {
      convertFileSrc: () =>
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="red"/></svg>',
        ),
    };
    const modal = document.querySelector('ion-modal')!;
    const content = document.createElement('div');
    content.setAttribute('part', 'content');
    content.style.cssText = 'position:absolute;inset:0;transform:translateY(40px)';
    content.append(document.createElement('slot'));
    modal.attachShadow({ mode: 'open' }).append(content);
    w.ui = await w.nativeRuntime
      .createNativeUI({
        getPlatform: () => 'ios',
        isAvailable: () => true,
        plugin: {
          configure: async () => ({ supported: true, coveredSnapshots: snapshots }),
          getWebViewMetrics: async () => ({ radius: 0, verticalBarEdge: 'trailing' }),
          getVerticalBarsGeometry: async () => ({ items: {} }),
          addListener: async () => ({ remove: async () => {} }),
          update: async (snapshot: any) => {
            w.updates.push(snapshot);
            return { revision: snapshot.revision };
          },
          clear: async () => {},
          stopOverlays: async () => {},
          coveredSnapshot: async (request: any) => {
            w.calls.push(request);
            return request.action === 'prepare'
              ? {
                  token: `capture-${w.calls.length}`,
                  parts: [{ ids: request.ids, url: 'file:///button.png', x: innerWidth - 72, y: 174, width: 48, height: 48 }],
                }
              : { shown: true };
          },
        },
      })
      .enableNativeUI({
        controls: 'verticalOnly',
        verticalBars: { reservedRegions: [{ kind: 'occlusion', isActive: true, x: innerWidth - 84, y: 0, width: 84, height: 174 }] },
      });
    modal.dispatchEvent(new CustomEvent('ionModalDidPresent', { bubbles: true }));
  }, snapshots);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1)?.controls.length ?? 0)).toBe(1);
  if (snapshots)
    await expect.poll(() => page.evaluate(() => (window as any).calls.some((call: any) => call.action === 'prepare'))).toBe(true);
};
const move = async (page: Page, y: number) => {
  await page.evaluate(async (y) => {
    const modal = document.querySelector('ion-modal')!;
    modal.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    (modal.shadowRoot!.querySelector('[part="content"]') as HTMLElement).style.transform = `translateY(${y}px)`;
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, y);
};

test('modal handoff retires and restores real native controls only after crossing the reservation', async ({ page }) => {
  await boot(page);
  await move(page, 100);
  expect(await page.evaluate(() => (window as any).calls.some((call: any) => call.action === 'cover'))).toBe(false);
  expect(await page.evaluate(() => (window as any).updates.at(-1).controls.length)).toBe(1);
  await move(page, 200);
  await expect.poll(() => page.evaluate(() => (window as any).calls.some((call: any) => call.action === 'cover'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1).controls.length)).toBe(0);
  await move(page, 100);
  await expect.poll(() => page.evaluate(() => (window as any).calls.some((call: any) => call.action === 'restore'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1).controls.length)).toBe(1);
  await page.evaluate(() => (window as any).ui.destroy());
});

test('a binary without snapshot support retains the fixed rail until Web fallback can follow dismissal', async ({ page }) => {
  await boot(page, false);
  await page.locator('ion-modal').dispatchEvent('ionModalWillDismiss');
  await move(page, 100);
  expect(await page.evaluate(() => (window as any).updates.at(-1).controls.length)).toBe(1);
  await move(page, 200);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1).controls.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await expect(page.locator('button[data-native-ui="button"]')).toBeVisible();
  await page.evaluate(() => (window as any).ui.destroy());
});
