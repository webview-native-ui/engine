import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
const runtime = readFileSync('runtime/native-ui-engine.js', 'utf8');

test('the bundled native runtime matches the TypeScript source', () => {
  const expected = buildSync({
    entryPoints: ['src/native/bootstrap.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'WebViewNativeUIEngineRuntime',
    minify: true,
    target: ['safari15', 'chrome100'],
    write: false,
  }).outputFiles[0].text;
  expect(runtime).toBe(expected);
});

test('injected runtime retains the existing Capacitor object and disposes a pending startup', async ({ page }) => {
  await page.setContent('<div id="slot" style="width:120px;height:40px"></div>');
  await page.evaluate(() => {
    const w = window as any;
    w.events = {};
    w.messages = [];
    w.removals = 0;
    w.originalCapacitor = {
      registerPlugin: () => {
        throw new Error('Must not register or wrap a plugin');
      },
      convertFileSrc: () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"/>'),
      addListener: (_plugin: string, name: string, fn: (event: unknown) => void) => {
        w.events[name] = fn;
        return {
          remove: () => {
            w.removals++;
            delete w.events[name];
          },
        };
      },
    };
    w.Capacitor = w.originalCapacitor;
    w.channel = {
      postMessage: (raw: string) => {
        w.messages.push(JSON.parse(raw));
      },
    };
  });
  await page.addScriptTag({ content: runtime });
  await page.evaluate(() => {
    const w = window as any;
    w.start = w.WebViewNativeUIEngineRuntime.start({
      id: 'channel',
      plugin: 'Fixture',
      projectionSelector: '#slot',
      receiveListeners: { update: ['updated'] },
    }).catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => (window as any).messages.length)).toBe(1);
  await page.evaluate(async () => {
    const w = window as any;
    await w.WebViewNativeUIEngineRuntime.stop('channel');
    await w.start;
    w.WebViewNativeUIEngineRuntime.receive('channel', w.messages[0].key, { destination: 'native' });
  });
  expect(await page.evaluate(() => (window as any).Capacitor === (window as any).originalCapacitor)).toBe(true);
  expect(await page.evaluate(() => Object.keys((window as any).events))).toEqual([]);
  expect(await page.evaluate(() => (window as any).messages.length)).toBe(1);
  await expect(page.locator('#slot')).not.toHaveAttribute('data-native-ui-snapshot');
});

test('Cordova notifications use the existing session without Capacitor subscriptions or duplicate application events', async ({ page }) => {
  await page.setContent('<div id="slot" style="width:120px;height:40px"></div>');
  await page.evaluate(() => {
    const w = window as any;
    w.messages = [];
    w.channel = {
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        w.messages.push(message.request);
        const result = message.request.action === 'connect' ? { destination: 'native' } : {};
        queueMicrotask(() => w.WebViewNativeUIEngineRuntime.receive('channel', message.key, result));
      },
    };
    // Even when both frameworks exist, a Cordova registration must not subscribe to Capacitor.
    w.Capacitor = {
      addListener: () => {
        throw new Error('Wrong bridge');
      },
    };
  });
  await page.addScriptTag({ content: runtime });
  await page.evaluate(async () => {
    const w = window as any;
    await w.WebViewNativeUIEngineRuntime.start({
      id: 'channel',
      runtime: 'cordova',
      plugin: 'Fixture',
      projectionSelector: '#slot',
      receiveListeners: { projection: { none: ['hidden'], native: ['shown'] }, match: { slot: 'first' } },
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).messages.some((m: any) => m.action === 'visibility' && m.visible)))
    .toBe(true);
  await page.evaluate(() => (window as any).WebViewNativeUIEngineRuntime.notify('channel', 'hidden', { slot: 'other' }));
  await expect(page.locator('#slot')).not.toHaveAttribute('data-native-ui-session-channel', 'none');
  await page.evaluate(() => (window as any).WebViewNativeUIEngineRuntime.notify('channel', 'hidden', { slot: 'first' }));
  await expect(page.locator('#slot')).toHaveAttribute('data-native-ui-session-channel', 'none');
  await page.evaluate(async () => {
    const w = window as any;
    await w.WebViewNativeUIEngineRuntime.stop('channel');
    w.count = w.messages.length;
    w.WebViewNativeUIEngineRuntime.notify('channel', 'shown', { slot: 'first' });
  });
  expect(await page.evaluate(() => (window as any).messages.length === (window as any).count)).toBe(true);
});

test('a delayed old stop cannot remove a restarted session interaction listener', async ({ page }) => {
  await page.setContent('<div id="slot" style="width:120px;height:40px"></div>');
  await page.evaluate(() => {
    const w = window as any;
    w.messages = [];
    w.listeners = [];
    w.Capacitor = {
      addListener: (_plugin: string, _name: string, listener: (event: unknown) => void) => {
        w.listeners.push(listener);
        const first = w.listeners.length === 1;
        return {
          remove: () =>
            first
              ? new Promise<void>((resolve) => {
                  w.finishOldRemoval = resolve;
                })
              : undefined,
        };
      },
    };
    w.channel = {
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        w.messages.push(message.request);
        queueMicrotask(() =>
          w.WebViewNativeUIEngineRuntime.receive(
            'channel',
            message.key,
            message.request.action === 'connect' ? { destination: 'native' } : {},
          ),
        );
      },
    };
  });
  await page.addScriptTag({ content: runtime });
  await page.evaluate(async () => {
    const w = window as any;
    w.config = { id: 'channel', plugin: 'Fixture', projectionSelector: '#slot', receiveListeners: { update: ['updated'] } };
    await w.WebViewNativeUIEngineRuntime.start(w.config);
  });
  const preparations = () => page.evaluate(() => (window as any).messages.filter((message: any) => message.action === 'prepare').length);
  await expect.poll(preparations).toBe(1);
  await page.evaluate(async () => {
    const w = window as any;
    w.oldStop = w.WebViewNativeUIEngineRuntime.stop('channel');
    await w.WebViewNativeUIEngineRuntime.start(w.config);
  });
  await expect.poll(preparations).toBe(2);
  await page.evaluate(async () => {
    const w = window as any;
    w.finishOldRemoval();
    await w.oldStop;
    w.WebViewNativeUIEngineRuntime.receive('channel', null, { active: true });
    w.listeners.at(-1)({});
  });
  // Capture is deferred during touch even after the previous owner's teardown completes.
  await page.waitForTimeout(100);
  expect(await preparations()).toBe(2);
  await page.evaluate(() => (window as any).WebViewNativeUIEngineRuntime.receive('channel', null, { active: false }));
  await expect.poll(preparations).toBe(3);
  await page.evaluate(() => (window as any).WebViewNativeUIEngineRuntime.stop('channel'));
});
