import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
const runtime = buildSync({
  entryPoints: ['src/native/resource-url.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'URLRuntime',
  write: false,
}).outputFiles[0].text;

test('uses the existing host file server without registering either framework', async ({ page }) => {
  await page.addScriptTag({ content: runtime });
  expect(await page.evaluate(() => (window as any).URLRuntime.projectionURL('/__native_ui_engine__/owner/image.png'))).toBe(
    '/__native_ui_engine__/owner/image.png',
  );
  await page.evaluate(() => {
    (window as any).WkWebView = { convertFilePath: (url: string) => 'app://localhost/_app_file_' + url.slice(7) };
  });
  expect(await page.evaluate(() => (window as any).URLRuntime.projectionURL('file:///cache/image.png'))).toBe(
    'app://localhost/_app_file_/cache/image.png',
  );
  expect(await page.evaluate(() => typeof (window as any).Capacitor)).toBe('undefined');
  await page.evaluate(() => {
    (window as any).Capacitor = { convertFileSrc: () => 'https://localhost/_capacitor_file_/image.png' };
  });
  expect(await page.evaluate(() => (window as any).URLRuntime.projectionURL('file:///cache/image.png'))).toBe(
    'https://localhost/_capacitor_file_/image.png',
  );
});
