import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = (entry: string, name: string) =>
  buildSync({ entryPoints: [entry], bundle: true, format: 'iife', globalName: name, write: false }).outputFiles[0].text;
const application = bundle('src/index.ts', 'appEngine');
const secondApplication = bundle('src/index.ts', 'otherEngine');
const runtime = bundle('src/native/bootstrap.ts', 'WebViewNativeUIEngineRuntime');
const ionic = bundle('src/ionic.ts', 'ionicEngine');

const boot = async (page: Page) => {
  await page.setContent('<main></main>');
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    w.visible = {};
    w.connect = {};
    w.Capacitor = {
      convertFileSrc: () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"/>'),
    };
    w.nativeUIEngine = {
      postMessage: (raw: string) => {
        const { key, request } = JSON.parse(raw);
        const id = key.split(':')[0];
        w.calls.push({ id, ...request });
        if (request.action === 'visibility') w.visible[id] = request.visible;
        if (request.action === 'cover') w.visible[id] = false;
        if (request.action === 'resume') w.visible[id] = true;
        const reply = (value: unknown) => w.WebViewNativeUIEngineRuntime.receive(id, key, value);
        if (request.action === 'resume' && w.holdResume) {
          w.resume = reply;
          return;
        }
        if (request.action === 'connect' && w.holdConnect) {
          w.connect[id] = reply;
          return;
        }
        queueMicrotask(() => {
          if (request.action === 'connect') reply({ destination: w.initial?.[id] ?? 'native' });
          else if (request.action === 'prepare' && !w.uncapturable?.includes(id)) {
            const { x, y, width, height } = document.getElementById(id)!.getBoundingClientRect();
            reply({ token: id, parts: [{ ids: ['view'], url: 'file:///pixels.png', x, y, width, height }] });
          } else if (request.action === 'cover' || request.action === 'restore') reply({ shown: true });
          else reply({});
        });
      },
    };
    w.start = (id: string) => {
      const host = document.createElement('div');
      host.id = id;
      host.style.cssText = 'width:120px;height:40px';
      host.innerHTML = '<button>Fallback</button>';
      document.querySelector('main')!.append(host);
      return w.WebViewNativeUIEngineRuntime.start({
        id,
        plugin: id,
        runtime: 'cordova',
        projectionSelector: '#' + id,
        failedFallback: 'native',
        receiveListeners: { projection: { native: ['shown'], web: ['moving'], none: ['hidden'] } },
      });
    };
  });
  await page.addScriptTag({ content: application });
  await page.addScriptTag({ content: secondApplication });
  await page.addScriptTag({ content: runtime });
};

const pause = (page: Page) => page.evaluate(() => (window as any).appEngine.pause());
const resume = (page: Page) => page.evaluate(() => (window as any).appEngine.resume());
const notify = (page: Page, id: string, name: string) =>
  page.evaluate(
    ({ id, name }) => {
      const w = window as any;
      if (name === 'shown') w.visible[id] = true;
      if (name === 'hidden') w.visible[id] = false;
      w.WebViewNativeUIEngineRuntime.notify(id, name, {});
    },
    { id, name },
  );

test('nested pauses cover multiple plugins and releases are shared across bundles', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const w = window as any;
    w.initial = { hidden: 'none' };
    w.uncapturable = ['fallback'];
    return Promise.all(['first', 'second', 'fallback', 'hidden'].map((id) => w.start(id)));
  });
  for (const id of ['first', 'second']) await expect(page.locator('#' + id)).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await resume(page); // An unmatched resume must not cancel the next pause.
  await page.evaluate(() => {
    const w = window as any;
    w.appEngine.pause();
    w.appEngine.resume();
    w.otherEngine.pause();
  });
  for (const id of ['first', 'second']) await expect(page.locator('#' + id)).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#fallback button')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).visible.fallback)).toBe(false);
  await expect(page.locator('#fallback')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  await expect(page.locator('#hidden')).toHaveAttribute('data-native-ui-destination', 'none');
  await pause(page);
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.action === 'cover').length)).toBe(2);
  await page.evaluate(() => (window as any).otherEngine.resume());
  for (const id of ['first', 'second']) await expect(page.locator('#' + id)).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await resume(page);
  for (const id of ['first', 'second']) {
    await expect(page.locator('#' + id)).toHaveAttribute('data-native-ui-session-' + id, 'native');
    await expect(page.locator('#' + id)).not.toHaveAttribute('data-native-ui-snapshot-visible');
  }
  await expect(page.locator('#fallback')).toHaveAttribute('data-native-ui-session-fallback', 'native');
  await expect(page.locator('#hidden')).toHaveAttribute('data-native-ui-destination', 'none');
  await page.evaluate(async () => {
    const w = window as any;
    await Promise.all(['first', 'second', 'fallback', 'hidden'].map((id) => w.WebViewNativeUIEngineRuntime.stop(id)));
    w.calls.length = 0;
    w.appEngine.pause();
    w.otherEngine.resume();
  });
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
});

test('pre-start and in-flight pauses preserve the native initial visibility', async ({ page }) => {
  await boot(page);
  await pause(page);
  await page.evaluate(async () => {
    const w = window as any;
    w.initial = { hidden: 'none' };
    await Promise.all([w.start('late'), w.start('hidden')]);
  });
  await expect(page.locator('#late')).toHaveAttribute('data-native-ui-destination', 'web');
  await expect(page.locator('#late button')).toBeVisible();
  await expect(page.locator('#hidden')).toHaveAttribute('data-native-ui-destination', 'none');
  expect(await page.evaluate(() => (window as any).calls.some((call: any) => call.action === 'visibility' && call.visible))).toBe(false);
  await resume(page);
  await expect(page.locator('#late')).toHaveAttribute('data-native-ui-session-late', 'native');
  await page.evaluate(() => {
    const w = window as any;
    w.holdConnect = true;
    w.starting = w.start('pending');
  });
  await expect.poll(() => page.evaluate(() => !!(window as any).connect.pending)).toBe(true);
  await pause(page);
  await page.evaluate(async () => {
    const w = window as any;
    w.connect.pending({ destination: 'none' });
    await w.starting;
  });
  await expect(page.locator('#pending')).toHaveAttribute('data-native-ui-destination', 'none');
});

test('a delayed native return cannot override a newer pause', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).start('first'));
  await expect(page.locator('#first')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await pause(page);
  await expect(page.locator('#first')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => {
    (window as any).holdResume = true;
  });
  await resume(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).resume)).toBe(true);
  await pause(page);
  await page.evaluate(() => (window as any).resume({}));
  await expect(page.locator('#first')).toHaveAttribute('data-native-ui-destination', 'web');
  await expect(page.locator('#first')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#first')).not.toHaveAttribute('data-native-ui-session-first', 'native');
});

for (const manualFirst of [true, false]) {
  test(`manual and Ionic pauses preserve mixed plugin intents (manual resumes first: ${manualFirst})`, async ({ page }) => {
    await boot(page);
    await page.addScriptTag({ content: ionic });
    await page.evaluate(async () => {
      const w = window as any;
      w.ionicEngine.enableSupportIonicOverlays();
      const modal = document.createElement('ion-modal');
      document.body.append(modal);
      for (const intent of ['native', 'web', 'none']) {
        for (const position of ['inside', 'outside']) {
          const id = intent + '-' + position;
          await w.start(id);
          if (position === 'inside') modal.append(document.getElementById(id)!);
        }
      }
      modal.dispatchEvent(new Event('ionModalWillPresent'));
    });
    for (const [intent, event] of [
      ['native', 'shown'],
      ['web', 'moving'],
      ['none', 'hidden'],
    ])
      for (const position of ['inside', 'outside']) await notify(page, intent + '-' + position, event);
    const states = () =>
      page
        .locator('main > div, ion-modal > div')
        .evaluateAll((hosts) => Object.fromEntries(hosts.map((host) => [host.id, host.getAttribute('data-native-ui-destination')])));
    const ordinary = {
      'native-inside': 'native',
      'native-outside': 'web',
      'web-inside': 'web',
      'web-outside': 'web',
      'none-inside': 'none',
      'none-outside': 'none',
    };
    await expect.poll(states).toEqual(ordinary);
    for (const id of ['web-inside', 'none-inside']) await notify(page, id, 'shown');
    await pause(page);
    await notify(page, 'web-inside', 'moving');
    await notify(page, 'none-inside', 'hidden');
    await notify(page, 'native-inside', 'shown');
    await expect.poll(() => page.evaluate(() => (window as any).visible['native-inside'])).toBe(false);
    await expect.poll(states).toEqual({ ...ordinary, 'native-inside': 'web' });
    const dismiss = () => page.evaluate(() => document.querySelector('ion-modal')!.dispatchEvent(new Event('ionModalDidDismiss')));
    if (manualFirst) {
      await resume(page);
      await expect.poll(states).toEqual(ordinary);
      await dismiss();
    } else {
      await dismiss();
      await expect.poll(states).toEqual({ ...ordinary, 'native-inside': 'web' });
      await resume(page);
    }
    await expect.poll(states).toEqual({ ...ordinary, 'native-outside': 'native' });
    await expect
      .poll(() => page.evaluate(() => ['native-inside', 'native-outside'].map((id) => (window as any).visible[id])))
      .toEqual([true, true]);
  });
}
