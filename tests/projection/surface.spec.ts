import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
const bundle = buildSync({ entryPoints: ['src/index.ts'], bundle: true, format: 'iife', globalName: 'engine', write: false }).outputFiles[0]
  .text;

for (const completion of ['ack', 'rejected'] as const) {
  test(`surface restores renderer-owned hosts in order after ${completion}`, async ({ page }) => {
    await page.setContent(
      '<main><button id="source">Application</button></main><aside><div id="one"></div><div id="two"></div><span id="tail"></span></aside><section></section><style>aside>div{width:40px;height:40px}</style>',
    );
    await page.addScriptTag({ content: bundle });
    await page.evaluate(async (completion) => {
      const w = window as any;
      w.Capacitor = {
        convertFileSrc: () =>
          'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>'),
      };
      const source = document.querySelector('#source')!;
      const hosts = [document.querySelector('#one')!, document.querySelector('#two')!];
      w.projection = await w.engine.createWebProjectionSurface(
        {
          listen: async () => ({ remove() {} }),
          send: async (request: any) =>
            request.action === 'prepare'
              ? {
                  token: 'pair',
                  parts: hosts.map((host, i) => ({ ids: [String(i)], url: 'file:///image.png', ...host.getBoundingClientRect().toJSON() })),
                }
              : { shown: completion !== 'rejected' },
        },
        {
          namespace: 'plain-dom',
          wake() {},
          blocked: () => false,
          captureDelayMs: 0,
          target: (candidate: any) => hosts[Number(candidate.control.id)],
          canRelocate: (target: HTMLElement) => hosts.includes(target),
        },
      );
      w.projection.consider(
        1,
        hosts.map((host, i) => ({ element: i ? host : source, control: { id: String(i), ...host.getBoundingClientRect().toJSON() } })),
      );
    }, completion);
    await expect(page.locator('#one')).toHaveAttribute('data-native-ui-snapshot', /.+/);
    await expect(page.locator('#two')).toHaveAttribute('data-native-ui-snapshot', /.+/);
    await page.evaluate(() => (window as any).projection.begin(document.querySelector('section')));
    await expect(page.locator('main > #source')).toHaveCount(1);
    if (completion === 'ack') {
      await expect(page.locator('section > div')).toHaveCount(2);
      await page.evaluate(() => (window as any).projection.end());
      await expect(page.locator('section > div')).toHaveCount(2);
      await page.evaluate(() => (window as any).projection.updated(undefined, ['0', '1'], 2));
    }
    await expect(page.locator('section > div')).toHaveCount(0);
    expect(await page.locator('aside > *').evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual(['one', 'two', 'tail']);
    await page.evaluate(() => (window as any).projection.destroy());
  });
}

test('surface group owns shared invalidation and ignores its image events until teardown', async ({ page }) => {
  await page.setContent('<main></main><section></section><img data-native-ui-projection-node><img id=content>');
  await page.addScriptTag({ content: bundle });
  expect(
    await page.evaluate(async () => {
      const group = (window as any).engine.createWebProjectionSurfaces();
      let changes = 0,
        invalidations = 0;
      for (const owner of document.querySelectorAll('main, section'))
        await group.ensure(owner, async () => ({
          changed() {
            changes++;
          },
          invalidate() {
            invalidations++;
          },
          async destroy() {},
        }));
      const load = (selector: string) =>
        new Promise<void>((resolve, reject) => {
          const image = document.querySelector<HTMLImageElement>(selector)!;
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('Image failed to load'));
          image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
        });
      await load('[data-native-ui-projection-node]');
      const ownImageChanges = changes;
      await load('#content');
      const contentChanges = changes;
      document.querySelector('main')!.dispatchEvent(new Event('transitionend', { bubbles: true }));
      window.dispatchEvent(new Event('resize'));
      await group.destroy();
      document.querySelector('main')!.dispatchEvent(new Event('transitionend', { bubbles: true }));
      window.dispatchEvent(new Event('resize'));
      return { ownImageChanges, contentChanges, changes, invalidations };
    }),
  ).toEqual({ ownImageChanges: 0, contentChanges: 2, changes: 4, invalidations: 2 });
});
