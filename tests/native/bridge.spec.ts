import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({
  entryPoints: ['src/native/bridge.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'bridge',
  write: false,
}).outputFiles[0].text;

test.beforeEach(async ({ page }) => {
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.addScriptTag({ content: bundle });
});

for (const delay of [6000, 2147483647]) {
  test(`native wait ${delay}ms retains the full processing budget without overflowing timers`, async ({ page }) => {
    await page.evaluate((delay) => {
      const w = window as any;
      w.state = 'pending';
      void w.bridge.bounded(new Promise((resolve) => (w.complete = resolve)), delay).then(
        () => (w.state = 'ready'),
        () => (w.state = 'expired'),
      );
    }, delay);
    await page.clock.runFor(delay + 4999);
    expect(await page.evaluate(() => (window as any).state)).toBe('pending');
    await page.evaluate(() => (window as any).complete('pixels'));
    expect(await page.evaluate(() => (window as any).state)).toBe('ready');
  });
}

test('an unanswered request expires after its native wait and processing budget', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.state = 'pending';
    void w.bridge.bounded(new Promise(() => {}), 6000).catch(() => (w.state = 'expired'));
  });
  await page.clock.runFor(10999);
  expect(await page.evaluate(() => (window as any).state)).toBe('pending');
  await page.clock.runFor(1);
  expect(await page.evaluate(() => (window as any).state)).toBe('expired');
});
