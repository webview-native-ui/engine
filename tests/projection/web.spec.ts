import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
const bundle = buildSync({ entryPoints: ['src/index.ts'], bundle: true, format: 'iife', globalName: 'engine', write: false }).outputFiles[0]
  .text;
const boot = async (page: Page) => {
  await page.setContent(
    '<main id="surface" style="position:relative"><div id="scroll" style="height:300px;width:300px;overflow:auto"><div style="height:100px"></div><div id="source" style="width:120px;height:40px"><button>Web action</button></div><div style="height:900px"></div></div></main><div id="other"></div>',
  );
  await page.evaluate(() => {
    (window as any).Capacitor = {
      convertFileSrc: (url: string) =>
        'data:image/svg+xml,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="${url.endsWith('/ad.png') ? 'blue' : 'red'}"/></svg>`,
        ),
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.createProjection = (target: HTMLElement, namespace: string, send: any, options = {}) =>
      w.engine.createWebProjection(
        w.engine.createWebProjectionScope(target, namespace),
        { listen: async () => ({ remove() {} }), send },
        { wake() {}, blocked: () => false, captureDelayMs: 0, ...options },
      );
  });
};
const prepare = async (
  page: Page,
  fail = false,
  shadow = false,
  proxy = false,
  shared = false,
  events = false,
  captureDelayMs?: number,
  transient = false,
) => {
  await boot(page);
  if (shadow)
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).append(document.querySelector('main')!);
      document.body.append(host);
      (window as any).sourceRoot = host.shadowRoot;
    });
  await page.evaluate(
    async ({ fail, proxy, shared, events, captureDelayMs, transient }) => {
      const w = window as any,
        source = (w.sourceRoot ?? document).querySelector('#source') as HTMLElement,
        owner = (w.sourceRoot ?? document).querySelector('#scroll') as HTMLElement;
      const rect = source.getBoundingClientRect(),
        viewport = owner.getBoundingClientRect();
      w.calls = [];
      w.revision = 1;
      w.failCover = false;
      w.coverReplies = [];
      if (proxy) {
        const target = document.createElement('button');
        target.id = 'proxy';
        target.textContent = 'Web proxy';
        document.body.append(target);
      }
      if (shared) {
        const host = document.createElement('div');
        host.id = 'projection-host';
        host.style.cssText = 'position:absolute;inset:0;z-index:7;pointer-events:none';
        document.querySelector('#surface')!.append(host);
      }
      w.scope = w.engine.createWebProjectionScope(
        shared ? document.getElementById('projection-host') : proxy ? document.getElementById('proxy') : source,
        'test',
      );
      w.source = {
        element: source,
        scrollElement: owner,
        control: {
          id: 'counter',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scroll: {
            id: 'owner',
            offsetX: 0,
            offsetY: 0,
            viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
            clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
            contentWidth: 300,
            contentHeight: 1040,
            frame: { x: 0, y: 100, width: 120, height: 40 },
          },
        },
      };
      w.manager = await w.engine.createWebProjection(
        w.scope,
        {
          send: async (request: any) => {
            w.calls.push(request);
            if (request.action === 'prepare')
              return fail
                ? {}
                : {
                    token: 'image',
                    parts: [{ ids: ['counter'], url: 'file:///image.png', x: rect.x, y: rect.y, width: rect.width, height: rect.height }],
                  };
            if (request.action === 'cover') {
              if (w.holdCover) return new Promise((resolve) => w.coverReplies.push(resolve));
              return { shown: !w.failCover };
            }
            return transient && request.action === 'restore' ? { shown: !w.failRestore } : {};
          },
          listen: async (listener: (event: { active: boolean }) => void) => {
            w.interact = listener;
            return {
              remove() {
                w.removed = true;
              },
            };
          },
        },
        {
          captureDelayMs,
          transient,
          wake() {},
          blocked: () => false,
          revision: () => w.revision,
          events: events
            ? {
                addListener: async (name: string, callback: (event: unknown) => void) => {
                  (w.eventListeners ??= {})[name] = callback;
                  return { remove: () => (w.removedEvents ??= []).push(name) };
                },
                update: ['setColors', 'shown'],
                projection: { native: ['shown'], web: ['transitionStarted'], none: ['hidden'] },
                accepts: (event: any) => event.id === 'counter',
              }
            : undefined,
        },
      );
      w.manager.consider(1, [w.source]);
    },
    { fail, proxy, shared, events, captureDelayMs, transient },
  );
  if (!fail)
    await expect(page.locator(shared ? '#projection-host' : proxy ? '#proxy' : '#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
};

test('returning images follow host motion until native acknowledges restoration', async ({ page }) => {
  await prepare(page);
  await page.clock.install();
  await page.evaluate(async () => {
    const w = window as any;
    w.registry = w.engine.createWebProjectionSurfaces();
    await w.registry.ensure(document.querySelector('main'), async () => w.manager);
    w.manager.begin();
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => {
    const w = window as any,
      host = document.querySelector('#source') as HTMLElement;
    host.style.boxSizing = 'border-box';
    w.manager.end();
    w.registry.changed();
    host.style.borderLeft = '20px solid blue';
    w.registry.followMotion(new Map([[host, true]]));
  });
  await page.clock.runFor(32);
  expect(
    await page.evaluate(() => {
      const host = document.querySelector('#source')!;
      return host.querySelector('img')!.getBoundingClientRect().x - host.getBoundingClientRect().x;
    }),
  ).toBe(0);
});

test('prepared pixels appear without a new capture; only matching restore ACK retires them', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#source > img')!).opacity)).toBe('1');
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'prepare').length)).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.manager.end();
    w.manager.updated(undefined, ['counter'], 1);
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => (window as any).manager.updated(undefined, ['counter'], 2));
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  await expect(page.locator('button')).toBeVisible();
});
for (const related of [true, false])
  test(`image geometry invalidation is owner-scoped (${related})`, async ({ page }) => {
    await prepare(page);
    const layers = await page.evaluate((related) => {
      const w = window as any,
        owner = document.querySelector('#scroll') as HTMLElement;
      if (related) owner.scrollTop = 50;
      w.manager.changed(related ? owner : document.querySelector('#other'));
      w.manager.begin();
      return w.manager.owners.length;
    }, related);
    expect(layers).toBe(related ? 0 : 1);
  });
test('capture absence preserves interactive Web without a presentation wait', async ({ page }) => {
  await prepare(page, true);
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('button')).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.action === 'cover'))).toBe(false);
});
test('cover refusal restores Web and removes snapshot ownership', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const w = window as any;
    w.failCover = true;
    w.manager.begin();
  });
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  await expect(page.locator('button')).toBeVisible();
  expect(await page.evaluate(() => (window as any).manager.owners.length)).toBe(0);
});
test('interaction keeps the completed pre-interaction image', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const w = window as any;
    w.interact({ active: true });
    w.manager.changed();
    w.manager.begin();
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'prepare').length)).toBe(1);
});
test('destruction releases only owned tokens, listeners and CSS', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const w = window as any;
    w.manager.begin();
    await w.manager.destroy();
  });
  await expect(page.locator('button')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return {
        removed: w.removed,
        owners: w.manager.owners.length,
        reset: w.calls.some((c: any) => c.action === 'reset'),
        released: w.calls.some((c: any) => c.action === 'release'),
        styles: document.querySelectorAll('style[data-native-ui-snapshot-base]').length,
      };
    }),
  ).toEqual({ removed: true, owners: 0, reset: false, released: true, styles: 0 });
});
test('a scope fixes an existing fallback DOM and rejects a document', async ({ page }) => {
  await boot(page);
  expect(
    await page.evaluate(() => {
      const w = window as any,
        fallback = document.querySelector('#source')!;
      const scope = w.engine.createWebProjectionScope(fallback, 'test');
      let rejected = false;
      try {
        w.engine.createWebProjectionScope(document, 'bad');
      } catch {
        rejected = true;
      }
      return { same: scope.element === fallback, frozen: Object.isFrozen(scope), rejected };
    }),
  ).toEqual({ same: true, frozen: true, rejected: true });
});
for (const rtl of [false, true])
  test(`fractional layout and direction remain intact (${rtl ? 'RTL' : 'LTR'})`, async ({ page }) => {
    await boot(page);
    const result = await page.evaluate((rtl) => {
      const w = window as any,
        owner = document.querySelector('#scroll') as HTMLElement,
        source = document.querySelector('#source') as HTMLElement;
      owner.style.cssText = 'width:300.5px;height:300px;overflow:auto;border:0.5px solid;direction:' + (rtl ? 'rtl' : 'ltr');
      source.parentElement!.firstElementChild!.setAttribute('style', 'width:1200px;height:100px');
      const p = w.engine.readScrollPlacement(source, owner, () => 'owner');
      const r = source.getBoundingClientRect();
      return { actual: p.frame.x + p.viewport.x - owner.scrollLeft, expected: r.x };
    }, rtl);
    expect(result.actual).toBeCloseTo(result.expected, 5);
  });
test('unsupported transforms keep the Web layout intact', async ({ page }) => {
  await boot(page);
  expect(
    await page.evaluate(() => {
      const w = window as any,
        owner = document.querySelector('#scroll') as HTMLElement;
      owner.style.transform = 'translateY(1px)';
      return w.engine.readScrollPlacement(document.querySelector('#source'), owner, () => 'owner');
    }),
  ).toBeUndefined();
});
test('ACK during motion never establishes a stale origin; content resize requires reacquisition', async ({ page }) => {
  await prepare(page);
  expect(
    await page.evaluate(() => {
      const w = window as any,
        b = w.engine.createScrollBindings(),
        s = w.source,
        owner = s.scrollElement;
      const attempt = b.acquiring([s], innerWidth);
      b.changed(owner);
      const stale = b.unconfirmed([s], attempt).has(owner),
        moving = b.eligible(s, innerWidth);
      b.settled(owner);
      b.acknowledge([s], innerWidth);
      const reuse = b.reuse(s, innerWidth);
      const changed = { ...s, control: { ...s.control, scroll: { ...s.control.scroll, contentHeight: 2000 } } };
      return { stale, moving, reuse, resized: b.reuse(changed, innerWidth) };
    }),
  ).toEqual({ stale: true, moving: false, reuse: true, resized: false });
});

test('image presentation works inside a shadow tree and restores Web', async ({ page }) => {
  await prepare(page, false, true);
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(await page.evaluate(() => getComputedStyle((window as any).source.element.querySelector('img')).opacity)).toBe('1');
  await page.evaluate(async () => (window as any).manager.destroy());
  await expect(page.locator('button')).toBeVisible();
  expect(await page.evaluate(() => (window as any).sourceRoot.querySelectorAll('style[data-native-ui-snapshot-base]').length)).toBe(0);
});

test('identical native tokens stay isolated across plugin scopes and teardown', async ({ page }) => {
  await prepare(page, false, false, true);
  await page.evaluate(async () => {
    const w = window as any,
      element = document.createElement('div');
    element.id = 'second';
    element.style.cssText = 'height:40px;width:120px';
    element.textContent = 'Ad slot';
    document.body.append(element);
    const r = element.getBoundingClientRect();
    w.secondScope = w.engine.createWebProjectionScope(element, 'ads');
    w.second = await w.engine.createWebProjection(
      w.secondScope,
      {
        send: async (request: any) =>
          request.action === 'prepare'
            ? { token: 'image', parts: [{ ids: ['ad'], url: 'file:///ad.png', x: r.x, y: r.y, width: r.width, height: r.height }] }
            : { shown: true },
        listen: async () => ({
          remove() {
            w.secondRemoved = true;
          },
        }),
      },
      { wake() {}, blocked: () => false },
    );
    w.second.consider(1, [{ element, control: { id: 'ad', x: r.x, y: r.y, width: r.width, height: r.height } }]);
  });
  await expect(page.locator('#second')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await page.evaluate(async () => {
    const w = window as any;
    w.manager.begin();
    w.second.begin();
  });
  await expect(page.locator('#second')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#proxy')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(
    await page.evaluate(() => {
      const first = document.querySelector('#proxy')!,
        second = document.querySelector('#second')!;
      return {
        distinct: first.getAttribute('data-native-ui-snapshot') !== second.getAttribute('data-native-ui-snapshot'),
        first: decodeURIComponent((first.querySelector('img') as HTMLImageElement).src).includes('fill="red"'),
        second: decodeURIComponent((second.querySelector('img') as HTMLImageElement).src).includes('fill="blue"'),
      };
    }),
  ).toEqual({ distinct: true, first: true, second: true });
  await page.evaluate(() => (window as any).manager.destroy());

  await expect(page.locator('#proxy')).not.toHaveAttribute('data-native-ui-snapshot-prepared');
  await expect(page.locator('#proxy')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return {
        owners: w.second.owners.length,
        removed: !!w.secondRemoved,
        opacity: getComputedStyle(document.querySelector('#second > img')!).opacity,
      };
    }),
  ).toEqual({ owners: 1, removed: false, opacity: '1' });
});

for (const shared of [false, true])
  test(`delayed cover never exposes pixels before Native is hidden (${shared})`, async ({ page }) => {
    await prepare(page, false, false, false, shared);
    const host = page.locator(shared ? '#projection-host' : '#source');
    await page.evaluate(() => {
      const w = window as any;
      w.holdCover = true;
      w.manager.begin();
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(host).not.toHaveAttribute('data-native-ui-snapshot-visible');
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return {
          pending: w.manager.handoffPending,
          visible: w.manager.visibleOwners.length,
          painted: w.calls.some((c: any) => c.action === 'painted'),
        };
      }),
    ).toEqual({ pending: false, visible: 0, painted: false });
    await page.evaluate(() => (window as any).coverReplies.shift()({ shown: true }));
    await expect(host).toHaveAttribute('data-native-ui-snapshot-visible', '');
    await expect.poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'painted').length)).toBe(1);
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'prepare').length)).toBe(1);
  });

test('a late cover reply cannot expose a reopened cached image before its own cover succeeds', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const w = window as any;
    w.holdCover = true;
    w.manager.begin();
    w.manager.end();
    w.manager.updated(undefined, ['counter'], 2);
    w.manager.begin();
    w.coverReplies.shift()({ shown: true });
  });
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  await page.evaluate(() => (window as any).coverReplies.shift()({ shown: true }));
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.action === 'prepare').length)).toBe(1);
});

test('cover without a positive acknowledgement restores Web ownership', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const w = window as any;
    w.holdCover = true;
    w.manager.begin();
    w.coverReplies.shift()({});
  });
  await expect.poll(() => page.evaluate(() => (window as any).manager.owners.length)).toBe(0);
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  expect(await page.evaluate(() => (window as any).manager.token)).toBeUndefined();
});

test('existing fallback DOM, listeners, values and application updates survive handoff', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const w = window as any,
      host = w.scope.element;
    w.originalHost = host;
    w.originalButton = host.querySelector('button');
    w.clicks = 0;
    w.originalButton.addEventListener('click', () => w.clicks++);
    host.setAttribute('aria-hidden', 'false');
    const input = document.createElement('input');
    input.value = 'before';
    host.append(input);
    w.originalInput = input;
    w.originalStyle = host.getAttribute('style');
    w.manager.begin();
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(
    await page.locator('img[data-native-ui-projection-image]').evaluate((image: HTMLImageElement) => ({
      inert: image.inert,
      hidden: image.getAttribute('aria-hidden'),
      pointer: getComputedStyle(image).pointerEvents,
    })),
  ).toEqual({ inert: true, hidden: 'true', pointer: 'none' });
  await page.evaluate(() => {
    const w = window as any;
    w.originalInput.value = 'updated';
    w.originalButton.disabled = true;
    w.manager.end();
    w.manager.updated(undefined, ['counter'], 2);
  });
  expect(
    await page.evaluate(() => {
      const w = window as any,
        host = document.querySelector('#source')!;
      return {
        same: host === w.originalHost,
        button: host.querySelector('button') === w.originalButton,
        input: host.querySelector('input') === w.originalInput,
        value: w.originalInput.value,
        disabled: w.originalButton.disabled,
        inert: host.hasAttribute('inert'),
        aria: host.getAttribute('aria-hidden'),
        style: host.getAttribute('style') === w.originalStyle,
      };
    }),
  ).toEqual({ same: true, button: true, input: true, value: 'updated', disabled: true, inert: false, aria: 'false', style: true });
  await page.evaluate(() => {
    (window as any).originalButton.disabled = false;
  });
  await page.locator('#source button').click();
  expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
});

test('fixed fallback follows its renderer-owned parent without recapturing', async ({ page }) => {
  await prepare(page, false, false, true);
  await page.evaluate(() => {
    const w = window as any,
      surface = document.querySelector<HTMLElement>('#surface')!;
    surface.style.transform = 'translate(10px,20px)';
    surface.append(w.scope.element);
    w.manager.begin();
  });
  await expect(page.locator('#proxy')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'prepare').length)).toBe(1);
  const relativeFrame = () =>
    page.evaluate(() => {
      const host = document.querySelector('#proxy')!;
      const image = host.querySelector('img')!.getBoundingClientRect();
      const target = host.getBoundingClientRect();
      return { x: image.x - target.x, y: image.y - target.y, width: image.width, height: image.height };
    });
  const beforeMove = await relativeFrame();
  await page.evaluate(() => {
    const w = window as any;
    document.querySelector('#other')!.append(w.scope.element);
    w.manager.moved();
  });
  expect(await relativeFrame()).toEqual(beforeMove);
  await page.evaluate(() => (window as any).manager.destroy());
  await expect(page.locator('#other #proxy')).toBeVisible();
});

test('detached fallback cannot be replaced by an unrelated DOM', async ({ page }) => {
  await prepare(page, false, false, true);
  await page.evaluate(() => {
    const w = window as any;
    w.scope.element.remove();
    w.manager.begin();
  });
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.action === 'cover'))).toBe(false);
});

test('fallback adopted into another document is rejected on return', async ({ page }) => {
  await prepare(page, false, false, true);
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('#proxy')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(
    await page.evaluate(() => {
      const w = window as any,
        frame = document.createElement('iframe');
      document.body.append(frame);
      frame.contentDocument!.body.append(w.scope.element);
      w.manager.end();
      return {
        owners: w.manager.owners.length,
        restoring: w.manager.restoring,
        visible: w.scope.element.hasAttribute('data-native-ui-snapshot-visible'),
        restores: w.calls.filter((c: any) => c.action === 'restore').length,
      };
    }),
  ).toEqual({ owners: 0, restoring: false, visible: false, restores: 0 });
});

test('batch uses one capture, listener and cover for multiple fixed fallback DOMs', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const w = window as any,
      first = document.querySelector<HTMLElement>('#source')!,
      second = document.querySelector<HTMLElement>('#other')!;
    second.style.cssText = 'width:120px;height:40px';
    w.calls = [];
    w.listeners = 0;
    w.batch = await w.engine.createWebProjectionBatch(
      {
        send: async (request: any) => {
          w.calls.push(request);
          return request.action === 'prepare'
            ? {
                token: 'batch',
                parts: request.ids.map((id: string) => ({ ids: [id], url: 'file:///pixels', x: 0, y: 0, width: 120, height: 40 })),
              }
            : { shown: true };
        },
        listen: async () => {
          w.listeners++;
          return { remove() {} };
        },
      },
      { wake() {}, blocked: () => false },
    );
    w.batchSources = [first, second].map((element, index) => ({
      scope: w.engine.createWebProjectionScope(element, 'batch'),
      element,
      control: { id: String(index), x: 0, y: 0, width: 120, height: 40 },
    }));
    w.batch.consider(1, w.batchSources);
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await expect(page.locator('#other')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await page.evaluate(() => (window as any).batch.begin());
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#other')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return {
        listeners: w.listeners,
        captures: w.calls.filter((c: any) => c.action === 'prepare').length,
        covers: w.calls.filter((c: any) => c.action === 'cover').length,
      };
    }),
  ).toEqual({ listeners: 1, captures: 1, covers: 1 });
  await page.evaluate(async () => {
    const w = window as any;
    w.batch.end();
    w.batch.updated(undefined, ['0', '1'], 2);
    await w.batch.destroy();
  });
  await expect(page.locator('#source button')).toBeVisible();
  await expect(page.locator('#other')).not.toHaveAttribute('data-native-ui-snapshot');
});

test('empty batch can begin and be destroyed before a document is known', async ({ page }) => {
  await boot(page);
  expect(
    await page.evaluate(async () => {
      const w = window as any;
      let listeners = 0;
      const batch = await w.engine.createWebProjectionBatch(
        {
          send: async () => ({}),
          listen: async () => {
            listeners++;
            return { remove() {} };
          },
        },
        { wake() {}, blocked: () => false },
      );
      batch.begin();
      batch.end();
      await batch.destroy();
      return listeners;
    }),
  ).toBe(0);
});

test('batch rejects mixed documents and disposes a listener resolved after teardown', async ({ page }) => {
  await boot(page);
  expect(
    await page.evaluate(async () => {
      const w = window as any;
      const source = document.querySelector<HTMLElement>('#source')!;
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const foreign = frame.contentDocument!.body;
      let resolveListener!: (handle: { remove(): void }) => void;
      let removed = 0;
      let sends = 0;
      const batch = await w.engine.createWebProjectionBatch(
        {
          send: async () => {
            sends++;
            return {};
          },
          listen: () =>
            new Promise((resolve) => {
              resolveListener = resolve;
            }),
        },
        { wake() {}, blocked: () => false },
      );
      const candidate = (element: HTMLElement) => ({
        scope: w.engine.createWebProjectionScope(element, 'batch'),
        element,
        control: { id: 'a', x: 0, y: 0, width: 120, height: 40 },
      });
      let rejected = false;
      try {
        batch.consider(1, [candidate(source), candidate(foreign)]);
      } catch {
        rejected = true;
      }
      batch.consider(2, [candidate(source)]);
      let laterRejected = false;
      try {
        batch.consider(3, [candidate(foreign)]);
      } catch {
        laterRejected = true;
      }
      const destroyed = batch.destroy();
      resolveListener({
        remove() {
          removed++;
        },
      });
      await destroyed;
      batch.consider(4, [candidate(source)]);
      return { rejected, laterRejected, removed, sends };
    }),
  ).toEqual({ rejected: true, laterRejected: true, removed: 1, sends: 0 });
});

test('replacing a fallback scope invalidates the old image even with unchanged native geometry', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const w = window as any;
    await w.manager.destroy();
    w.batch = await w.engine.createWebProjectionBatch(
      {
        send: async (request: any) => {
          if (request.action === 'prepare')
            return { token: 'same', parts: [{ ids: ['counter'], url: 'file:///image', ...w.source.control }] };
          return { shown: true };
        },
        listen: async () => ({ remove() {} }),
      },
      { wake() {}, blocked: () => false },
    );
    w.batch.consider(1, [{ ...w.source, scope: w.scope }]);
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await page.evaluate(() => {
    const w = window as any;
    const other = document.querySelector<HTMLElement>('#other')!;
    other.style.cssText = 'width:120px;height:40px';
    w.batch.consider(1, [{ ...w.source, scope: w.engine.createWebProjectionScope(other, 'test') }]);
  });
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot');
  await expect(page.locator('#other')).toHaveAttribute('data-native-ui-snapshot', /.+/);
});

for (const detached of [false, true]) {
  test(`in-flight capture cannot adopt a replaced scope (old DOM detached: ${detached})`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async () => {
      const w = window as any;
      w.captures = 0;
      w.released = [];
      const source = document.querySelector<HTMLElement>('#source')!;
      const old = document.createElement('div');
      old.id = 'old-fallback';
      old.style.cssText = 'width:120px;height:40px';
      document.body.append(old);
      const fallback = document.querySelector<HTMLElement>('#other')!;
      fallback.style.cssText = old.style.cssText;
      w.old = old;
      w.source = { element: source, control: { id: 'counter', x: 0, y: 0, width: 120, height: 40 } };
      w.batch = await w.engine.createWebProjectionBatch(
        {
          send: async (request: any) => {
            if (request.action === 'release') w.released.push(request.token);
            if (request.action !== 'prepare') return { shown: true };
            const serial = ++w.captures;
            const result = {
              token: String(serial),
              parts: [{ ids: ['counter'], url: 'file:///image', x: 0, y: 0, width: 120, height: 40 }],
            };
            if (serial === 1)
              return new Promise((resolve) => {
                w.finish = () => resolve(result);
              });
            return result;
          },
          listen: async () => ({ remove() {} }),
        },
        { wake() {}, blocked: () => false },
      );
      w.batch.consider(1, [{ ...w.source, scope: w.engine.createWebProjectionScope(old, 'test') }]);
    });
    await expect.poll(() => page.evaluate(() => (window as any).captures)).toBe(1);
    await page.evaluate((detached) => {
      const w = window as any;
      if (detached) w.old.remove();
      w.batch.consider(1, [{ ...w.source, scope: w.engine.createWebProjectionScope(document.querySelector('#other'), 'test') }]);
      w.finish();
    }, detached);
    await expect(page.locator('#other')).toHaveAttribute('data-native-ui-snapshot', /.+/);
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return { old: w.old.hasAttribute('data-native-ui-snapshot'), captures: w.captures, released: w.released };
      }),
    ).toEqual({ old: false, captures: 2, released: ['1'] });
  });
}

test('replaced fallback elements are rejected before native ownership can change', async ({ page }) => {
  await boot(page);
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return ['img', 'input', 'video', 'canvas', 'select', 'textarea', 'iframe'].map((tag) => {
        try {
          w.engine.createWebProjectionScope(document.createElement(tag), 'test');
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      });
    }),
  ).toEqual([true, true, true, true, true, true, true]);
});

test('plugin events preserve web projection through updates and ignore other surfaces', async ({ page }) => {
  await prepare(page, false, false, false, false, true);
  await page.evaluate(() => (window as any).eventListeners.transitionStarted({ id: 'other' }));
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  await page.evaluate(() => (window as any).eventListeners.transitionStarted({ id: 'counter' }));
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => {
    const w = window as any;
    for (let i = 0; i < 20; i++) w.eventListeners.setColors({ id: 'counter' });
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.action === 'prepare').length)).toBe(1);
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => (window as any).eventListeners.shown({ id: 'counter' }));
  // Notifications never bypass the native draw acknowledgement.
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await page.evaluate(() => (window as any).manager.updated(undefined, ['counter'], 2));
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
});

test('hidden notification invalidates delayed cover and updates cannot resurrect it', async ({ page }) => {
  await prepare(page, false, false, false, false, true);
  await page.evaluate(() => {
    const w = window as any;
    w.holdCover = true;
    w.eventListeners.transitionStarted({ id: 'counter' });
    w.eventListeners.hidden({ id: 'counter' });
    w.coverReplies.splice(0).forEach((resolve: (value: { shown: boolean }) => void) => resolve({ shown: true }));
    w.eventListeners.setColors({ id: 'counter' });
  });
  await page.waitForTimeout(100);
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible');
  expect(await page.evaluate(() => (window as any).calls.filter((call: any) => call.action === 'prepare').length)).toBe(1);
  await page.evaluate(() => (window as any).eventListeners.shown({ id: 'counter' }));
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await page.evaluate(async () => {
    const w = window as any;
    await w.manager.destroy();
    Object.values(w.eventListeners).forEach((callback: any) => callback({ id: 'counter' }));
  });
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot');
  expect(await page.evaluate(() => (window as any).removedEvents.sort())).toEqual(['hidden', 'setColors', 'shown', 'transitionStarted']);
});

test('renderer visibility excludes Engine hiding without changing authored visibility or projection ownership', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const source = document.querySelector('#source') as HTMLElement;
    source.setAttribute('data-native-ui-session-fixture', 'native');
    const style = document.createElement('style');
    style.textContent = '[data-native-ui-session-fixture] { visibility:hidden!important }';
    document.head.append(style);
  });
  const read = () =>
    page.evaluate(() => {
      const source = document.querySelector('#source') as HTMLElement;
      const before = source.outerHTML;
      const visibility = (window as any).engine.getUnprojectedVisibility(source);
      return { visibility, unchanged: before === source.outerHTML, projected: getComputedStyle(source).visibility };
    });
  expect(await read()).toEqual({ visibility: 'visible', unchanged: true, projected: 'hidden' });
  await page.evaluate(() => (document.querySelector<HTMLElement>('#scroll')!.style.visibility = 'hidden'));
  expect(await read()).toEqual({ visibility: 'hidden', unchanged: true, projected: 'hidden' });
  await page.evaluate(() => (document.querySelector<HTMLElement>('#source')!.style.visibility = 'visible'));
  expect(await read()).toEqual({ visibility: 'visible', unchanged: true, projected: 'hidden' });
});

for (const delay of [undefined, 300]) {
  test(`capture delay ${delay ?? 'default 50'} debounces updates without blocking prepared handoff`, async ({ page }) => {
    await prepare(page, false, false, false, false, false, delay);
    const now = new Date('2026-01-01T00:00:00Z');
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    const interval = delay ?? 50;
    const captures = () => page.evaluate(() => (window as any).calls.filter((call: any) => call.action === 'prepare').length);
    const update = () =>
      page.evaluate(() => {
        const w = window as any;
        w.manager.consider(++w.revision, [w.source]);
      });
    await update();
    await page.clock.runFor(interval - 1);
    expect(await captures()).toBe(1);
    await update();
    await page.clock.runFor(interval - 1);
    expect(await captures()).toBe(1);
    await page.clock.runFor(1);
    expect(await captures()).toBe(2);
    await update();
    await page.evaluate(() => (window as any).manager.begin());
    await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
    await page.clock.runFor(interval * 2);
    expect(await captures()).toBe(2);
  });
}

const destroyProjection = async (page: Page) => {
  await page.evaluate(() => (window as any).manager.destroy());
  await expect(page.locator('img')).toHaveCount(0);
};

test('inner multiple parts retain overlap order and remove every node', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const w = window as any,
      source = document.querySelector('#source')!,
      r = source.getBoundingClientRect();
    w.manager = await w.createProjection(source, 'parts', async (req: any) =>
      req.action === 'prepare'
        ? {
            token: 'parts',
            parts: [
              { ids: ['a'], url: 'file:///red.png', x: r.x, y: r.y, width: 120, height: 40 },
              { ids: ['b'], url: 'file:///ad.png', x: r.x + 20, y: r.y, width: 120, height: 40 },
            ],
          }
        : { shown: true },
    );
    w.manager.consider(
      1,
      ['a', 'b'].map((id) => ({ element: source, control: { id, x: r.x, y: r.y, width: 120, height: 40 } })),
    );
  });
  await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCount(2);
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('img[data-native-ui-projection-image]').last()).toHaveCSS('opacity', '1');
  expect(await page.locator('img[data-native-ui-projection-image]').last().getAttribute('src')).toContain('red');
  await page.evaluate(() => (window as any).manager.destroy());
  await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCount(0);
});

for (const scenario of ['fractional-rtl', 'nested-scroll', 'parent-scale', 'host-scale', 'slot'])
  test(`inner coordinates ${scenario}`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async (scenario) => {
      const w = window as any,
        target = document.querySelector('#source') as HTMLElement,
        parent = target.parentElement!;
      parent.style.position = 'relative';
      if (scenario === 'fractional-rtl') {
        parent.style.cssText += 'direction:rtl;border:0.5px solid;padding:7.25px;';
        target.style.cssText += 'width:120.5px;height:40.5px;margin-top:2.25px';
      }
      if (scenario === 'nested-scroll') {
        parent.scrollTop = 27;
        parent.style.border = '3px solid';
      }
      if (scenario === 'parent-scale') parent.style.transform = 'scale(.8)';
      if (scenario === 'host-scale') target.style.transform = 'scale(.8)';
      if (scenario === 'slot') {
        const host = document.createElement('section');
        host.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:relative"><slot name="x"></slot></div>';
        parent.append(host);
        target.slot = 'x';
        host.append(target);
      }
      const rect = target.getBoundingClientRect();
      w.expected = { x: rect.x - 3.25, y: rect.y - 4.5, width: 125.5, height: 49.5 };
      w.manager = await w.createProjection(target, 'geometry', async (req: any) =>
        req.action === 'prepare' ? { token: 'geometry', parts: [{ ids: ['a'], url: 'file:///red.png', ...w.expected }] } : { shown: true },
      );
      w.manager.consider(1, [{ element: target, control: { id: 'a', ...rect.toJSON() } }]);
    }, scenario);
    await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCount(1);
    await page.evaluate(() => (window as any).manager.begin());
    await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
    const result = await page.evaluate(() => ({
      expected: (window as any).expected,
      actual: document.querySelector('img[data-native-ui-projection-image]')!.getBoundingClientRect().toJSON(),
    }));
    for (const key of ['x', 'y', 'width', 'height']) expect(result.actual[key]).toBeCloseTo(result.expected[key], 1);
    if (scenario === 'parent-scale') {
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#source')!.parentElement!.style.transform = 'scale(.72)';
        (window as any).manager.moved();
      });
      const after = await page.locator('img[data-native-ui-projection-image]').boundingBox();
      expect(after!.width).toBeCloseTo(result.actual.width * 0.9, 1);
      expect(after!.height).toBeCloseTo(result.actual.height * 0.9, 1);
    }
  });

for (const transient of [false, true]) {
  test(`handoff retains prepared DOM through ${transient ? 'a moved native return' : 'repeated switches'}`, async ({ page }) => {
    await prepare(page, false, false, false, false, false, 0, transient);
    await page.evaluate(() => {
      const w = window as any;
      w.treeChanges = 0;
      w.treeObserver = new MutationObserver((records) => (w.treeChanges += records.length));
      w.treeObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
    for (let i = 0; i < (transient ? 1 : 5); i++) {
      await page.evaluate(() => (window as any).manager.begin());
      await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
      await page.evaluate((transient) => {
        const w = window as any;
        if (transient) document.querySelector<HTMLElement>('#source')!.style.transform = 'translateX(20px)';
        w.manager.end();
        w.manager.updated(undefined, ['counter'], 1000);
      }, transient);
      await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '0');
    }
    if (transient)
      expect(
        await page.evaluate(() => {
          const part = (window as any).calls.find((c: any) => c.action === 'restore').parts[0];
          return Math.abs(part.x - document.querySelector('#source')!.getBoundingClientRect().x);
        }),
      ).toBeLessThan(0.01);
    expect(await page.evaluate(() => (window as any).treeChanges)).toBe(0);
    await page.evaluate(() => (window as any).treeObserver.disconnect());
    await destroyProjection(page);
  });
}

test('translated transient pixels survive immediate redrag until a replacement is ready', async ({ page }) => {
  await prepare(page, false, false, false, false, false, 50, true);
  const result = await page.evaluate(async () => {
    const w = window as any;
    // Hold replacement captures throughout the test, independently of machine speed.
    w.interact({ active: true });
    const captures = w.calls.filter((c: any) => c.action === 'prepare').length;
    const source = document.querySelector<HTMLElement>('#source')!;
    const originalY = source.getBoundingClientRect().y;
    // Idle translation has no preceding restore, and an optional return copy can fail.
    source.style.transform = 'translateY(10px)';
    w.source.control.y = originalY + 10;
    w.manager.consider(++w.revision, [w.source]);
    w.failRestore = true;
    for (const y of [20, 0, 30]) {
      w.manager.begin();
      await Promise.resolve();
      source.style.transform = `translateY(${y}px)`;
      w.manager.end();
      w.manager.updated(undefined, ['counter'], ++w.revision);
      w.source.control.y = source.getBoundingClientRect().y;
      w.manager.consider(w.revision, [w.source]);
    }
    w.manager.begin();
    await Promise.resolve();
    const covers = w.calls.filter((c: any) => c.action === 'cover').length;
    const coverOffsets = w.calls.filter((c: any) => c.action === 'cover').map((c: any) => c.parts[0].y - originalY);
    const extraCaptures = w.calls.filter((c: any) => c.action === 'prepare').length - captures;
    const image = document.querySelector('img[data-native-ui-projection-image]')!;
    const offset = image.getBoundingClientRect().y - source.getBoundingClientRect().y;
    w.manager.end();
    w.manager.updated(undefined, ['counter'], ++w.revision);
    w.source.control.width++;
    w.manager.consider(w.revision, [w.source]);
    w.manager.begin();
    return { covers, coverOffsets, extraCaptures, offset, afterResize: w.calls.filter((c: any) => c.action === 'cover').length };
  });
  expect(result).toEqual({ covers: 4, coverOffsets: [10, 20, 0, 30], extraCaptures: 0, offset: 0, afterResize: 4 });
  await destroyProjection(page);
});

test('moving a source within a fixed transient scope invalidates its old image layout', async ({ page }) => {
  await prepare(page, false, false, false, true, false, 50, true);
  await page.evaluate(() => {
    const w = window as any;
    w.interact({ active: true });
    const source = document.querySelector<HTMLElement>('#source')!;
    source.style.transform = 'translateY(90px)';
    w.source.control.y = source.getBoundingClientRect().y;
    w.manager.consider(++w.revision, [w.source]);
    w.manager.begin();
  });
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'cover'))).toEqual([]);
  await destroyProjection(page);
});

for (const delayed of [false, true]) {
  test(`release acknowledgement (delayed: ${delayed}) preserves pixels and bounds buffers`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async (delayed) => {
      const w = window as any,
        target = document.querySelector('#source')!,
        r = target.getBoundingClientRect();
      w.captures = w.adoptions = 0;
      w.releases = [];
      window.addEventListener('retained:sources-change', () => {
        if (target.hasAttribute('data-native-ui-snapshot')) w.adoptions++;
      });
      w.manager = await w.createProjection(
        target,
        'retained',
        async (req: any) => {
          if (req.action === 'prepare')
            return {
              token: `image-${++w.captures}`,
              parts: [
                {
                  ids: ['a'],
                  url: w.captures > 1 ? 'file:///ad.png' : 'file:///red.png',
                  x: r.x,
                  y: r.y,
                  width: 120,
                  height: 40,
                },
              ],
            };
          if (delayed && req.action === 'release') return new Promise((resolve) => w.releases.push(resolve));
          return { shown: true };
        },
        { opaqueUnderlay: true, retainPreparedUntilRelease: true },
      );
      w.sources = [{ element: target, control: { id: 'a', x: r.x, y: r.y, width: 120, height: 40 } }];
      w.manager.consider(1, w.sources);
    }, delayed);
    for (let i = 1; i <= 5; i++) {
      await expect.poll(() => page.evaluate(() => (window as any).adoptions)).toBe(i);
      if (!delayed) expect(await page.locator('img').count()).toBeLessThanOrEqual(2);
      if (i < 5)
        await page.evaluate((i) => {
          const w = window as any;
          w.manager.invalidate();
          w.manager.consider(i + 1, w.sources);
        }, i);
    }
    await expect(page.locator('img[data-native-ui-projection-image]')).toHaveAttribute('src', /blue/);
    await page.evaluate(() => {
      const w = window as any;
      w.releases.splice(0).forEach((r: any) => r({}));
    });
    await expect.poll(() => page.locator('img').count()).toBeLessThanOrEqual(2);
    await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
    expect(
      await page.evaluate(() => {
        const image = document.querySelector('img[data-native-ui-projection-image]') as HTMLImageElement;
        return decodeURIComponent(image.src).includes('blue') && image.complete && image.naturalWidth === 120;
      }),
    ).toBe(true);
    await destroyProjection(page);
  });
}

for (const previous of [false, true]) {
  test(`failed insertion preserves ${previous ? 'the completed image' : 'the live fallback'}`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async (previous) => {
      const w = window as any;
      const target = document.querySelector('#source') as HTMLElement;
      const rect = target.getBoundingClientRect();
      w.calls = [];
      w.captures = 0;
      w.manager = await w.createProjection(target, 'insertion', async (request: any) => {
        w.calls.push(request);
        if (request.action === 'prepare') {
          const successful = previous && ++w.captures === 1;
          return {
            token: successful ? 'good' : 'failed',
            parts: [{ ids: ['one'], url: successful ? 'file:///red.png' : 'file:///ad.png', ...rect.toJSON() }],
          };
        }
        return { shown: true };
      });
      const parent = target;
      const insert = parent.insertBefore.bind(parent);
      parent.insertBefore = (node: Node, reference: Node | null) => {
        const result = insert(node, reference);
        if (node instanceof HTMLImageElement && decodeURIComponent(node.src).includes('blue')) throw new Error('Insertion rejected');
        return result;
      };
      w.manager.consider(1, [{ element: target, control: { id: 'one', ...rect.toJSON() } }]);
    }, previous);
    if (previous) {
      await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
      await page.evaluate(() => (window as any).manager.changed());
    }
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).calls.some((request: any) => request.action === 'release' && request.token === 'failed')),
      )
      .toBe(true);
    await page.evaluate(() => (window as any).manager.begin());
    if (previous) {
      await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
      expect(await page.evaluate(() => (window as any).manager.token)).toBe('good');
    } else {
      await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot');
      await expect(page.getByRole('button', { name: 'Web action' })).toBeVisible();
    }
    expect(
      await page.evaluate(() =>
        (window as any).calls.some(
          (request: any) => ['cover', 'painted', 'prepared'].includes(request.action) && request.token === 'failed',
        ),
      ),
    ).toBe(false);
    await destroyProjection(page);
  });
}

for (const shadow of [false, true]) {
  test(`inner projection preserves scroll clipping and fallback lifecycle (shadow: ${shadow})`, async ({ page }) => {
    await prepare(page);
    await page.evaluate((shadow) => {
      const target = (window as any).scope.element as HTMLElement;
      if (shadow) target.attachShadow({ mode: 'open' }).innerHTML = '<div style="overflow:hidden;padding:20px"><slot></slot></div>';
      (window as any).manager.begin();
    }, shadow);
    const image = page.locator('img[data-native-ui-projection-image]');
    await expect(image).toHaveCSS('opacity', '1');
    expect(await image.boundingBox()).toEqual(await page.locator('#source').boundingBox());
    const outside = { x: 10, y: 0, width: 100, height: 8 };
    const clipped = await page.screenshot({ clip: outside });
    await page.evaluate(() => {
      document.querySelector('#scroll')!.scrollTop = 120;
    });
    expect(await page.screenshot({ clip: outside })).toEqual(clipped);
    // No moved() call: the CSS containing block must carry the image while scrolling.
    expect(await image.boundingBox()).toEqual(await page.locator('#source').boundingBox());
    await page.evaluate(() => (window as any).manager.destroy());
    await expect(page.locator('img[data-native-ui-projection-node]')).toHaveCount(0);
    await page.evaluate(() => {
      document.querySelector('#scroll')!.scrollTop = 0;
    });
    await expect(page.getByRole('button', { name: 'Web action' })).toBeVisible();
  });
}

for (const location of ['host', 'light', 'shadow-host', 'shadow', 'nested-shadow'] as const) {
  test(`projection suppresses and restores explicit pseudo-elements in ${location}`, async ({ page }) => {
    await prepare(page);
    await page.evaluate((location) => {
      const w = window as any;
      const host = w.scope.element as HTMLElement;
      let root: Document | ShadowRoot = document;
      let target = host;
      if (location === 'shadow-host') root = host.attachShadow({ mode: 'open' });
      else if (location !== 'host') {
        if (location.includes('shadow')) root = host.attachShadow({ mode: 'open' });
        target = document.createElement('span');
        (root === document ? host : root).append(target);
        if (location === 'nested-shadow') {
          root = target.attachShadow({ mode: 'open' });
          target = document.createElement('span');
          root.append(target);
        }
      }
      target.id = 'decoration';
      const style = document.createElement('style');
      style.textContent =
        '#decoration::before, #decoration::after { content:"Decoration"; position:absolute; inset:0; background:lime; visibility:visible!important; transition:visibility 500ms linear; }';
      if (location === 'shadow-host') style.textContent = style.textContent.replaceAll('#decoration', ':host');
      (root === document ? document.head : root).append(style);
      w.decoration = target;
      w.decorations = () =>
        ['::before', '::after'].map((pseudo) => {
          const css = getComputedStyle(target, pseudo);
          return { content: css.content, visibility: css.visibility, background: css.backgroundColor };
        });
      w.original = w.decorations();
      w.manager.begin();
    }, location);
    await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => (window as any).decorations().map((s: any) => s.visibility))).toEqual(['hidden', 'hidden']);
    await page.evaluate(() => {
      const w = window as any;
      w.manager.end();
      w.manager.updated(undefined, ['counter'], 1000);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as any).decorations())).toEqual(await page.evaluate(() => (window as any).original));
    await page.evaluate(() => (window as any).manager.destroy());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as any).decorations())).toEqual(await page.evaluate(() => (window as any).original));
  });
}

test('hiding fallback content does not cancel its other CSS transitions', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const button = document.querySelector('button')!;
    button.style.transition = 'opacity 10s linear';
    button.getAnimations();
    button.style.opacity = '0.5';
    (window as any).opacityTransition = button
      .getAnimations()
      .find((animation) => 'transitionProperty' in animation && animation.transitionProperty === 'opacity');
    (window as any).manager.begin();
  });
  await expect(page.locator('img[data-native-ui-projection-image]')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => (window as any).opacityTransition?.playState)).toBe('running');
  await page.evaluate(() => (window as any).manager.destroy());
  expect(await page.evaluate(() => (window as any).opacityTransition?.playState)).toBe('running');
});

test('renderer visibility ignores projection hiding across an open shadow boundary', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>('#source')!;
    source.attachShadow({ mode: 'open' }).innerHTML = '<span id="fallback">Fallback</span>';
    (window as any).manager.begin();
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-content', '');
  const read = () =>
    page.evaluate(() => {
      const source = document.querySelector<HTMLElement>('#source')!;
      const child = source.shadowRoot!.querySelector<HTMLElement>('#fallback')!;
      return {
        host: (window as any).engine.getUnprojectedVisibility(source),
        child: (window as any).engine.getUnprojectedVisibility(child),
        projected: getComputedStyle(child).visibility,
        marker: source.hasAttribute('data-native-ui-snapshot-content'),
      };
    });
  expect(await read()).toEqual({ host: 'visible', child: 'visible', projected: 'hidden', marker: true });
  await page.evaluate(() => (document.querySelector<HTMLElement>('#scroll')!.style.visibility = 'hidden'));
  expect(await read()).toEqual({ host: 'hidden', child: 'hidden', projected: 'hidden', marker: true });
});

test('an expired native entry retires the delayed Web image', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const w = window as any;
    await w.manager.destroy();
    w.manager = await w.createProjection(document.querySelector('#source'), 'expired', async (request: any) => {
      if (request.action === 'prepare')
        return { token: 'expired', parts: [{ ids: ['counter'], url: 'file:///image.png', ...w.source.control }] };
      if (request.action === 'cover') return { shown: true };
      if (request.action === 'painted') return new Promise((resolve) => (w.painted = resolve));
      return {};
    });
    w.manager.consider(1, [w.source]);
  });
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot', /.+/);
  await page.evaluate(() => (window as any).manager.begin());
  await expect.poll(() => page.evaluate(() => !!(window as any).painted)).toBe(true);
  await page.evaluate(() => (window as any).painted({ shown: false }));
  await expect(page.locator('#source')).not.toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#source > button')).toBeVisible();
});

test('projection preserves host opacity and clipping', async ({ page }) => {
  await prepare(page);
  await page.locator('#source').evaluate((host) => {
    host.style.opacity = '0.25';
    host.style.overflow = 'hidden';
  });
  await page.evaluate(() => (window as any).manager.begin());
  await expect(page.locator('#source')).toHaveAttribute('data-native-ui-snapshot-visible', '');
  await expect(page.locator('#source')).toHaveCSS('opacity', '0.25');
  await expect(page.locator('#source')).toHaveCSS('overflow', 'hidden');
});
