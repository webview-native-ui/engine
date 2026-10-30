/*!
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
const bundle = buildSync({
  entryPoints: ['src/projection/surfaces.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'surfaces',
  write: false,
}).outputFiles[0].text;

test.beforeEach(async ({ page }) => {
  await page.setContent('<main></main>');
  await page.addScriptTag({ content: bundle });
});

test('dismissal and reopening during preparation cannot publish or dispose the wrong surface', async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const registry = (window as any).surfaces.createWebProjectionSurfaces();
      const owner = document.querySelector('main')!;
      const disposed: string[] = [];
      let finish!: (surface: unknown) => void;
      const old = registry.ensure(
        owner,
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const duplicate = registry.ensure(owner, () => {
        throw new Error('Duplicate creation');
      });
      await Promise.resolve();
      const removal = registry.delete(owner);
      const current = await registry.ensure(owner, async () => ({
        destroy: async () => {
          disposed.push('current');
        },
      }));
      finish({
        destroy: async () => {
          disposed.push('old');
        },
      });
      await removal;
      const result = {
        deduplicated: old === duplicate,
        retired: await old,
        current: registry.get(owner) === current,
        disposed: [...disposed],
      };
      await registry.destroy();
      await registry.destroy();
      return { ...result, final: disposed };
    }),
  ).toEqual({ deduplicated: true, retired: undefined, current: true, disposed: ['old'], final: ['old', 'current'] });
});

for (const retire of ['disconnect', 'destroy'] as const) {
  test(`a ${retire} during preparation disposes late results`, async ({ page }) => {
    expect(
      await page.evaluate(async (retire) => {
        const registry = (window as any).surfaces.createWebProjectionSurfaces();
        const owner = document.querySelector('main')!;
        let rejected = false;
        try {
          await registry.ensure(owner, async () => {
            throw new Error('Unavailable');
          });
        } catch {
          rejected = true;
        }
        let finish!: (surface: unknown) => void;
        let disposed = 0;
        const pending = registry.ensure(
          owner,
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        await Promise.resolve();
        const cleanup = retire === 'destroy' ? registry.destroy() : (owner.remove(), Promise.resolve());
        finish({
          destroy: async () => {
            disposed++;
          },
        });
        await cleanup;
        const result = await pending;
        const late = await registry.ensure(owner, async () => {
          throw new Error('Retired owner must not create');
        });
        return { rejected, result, late, disposed, count: registry.values().length };
      }, retire),
    ).toEqual({ rejected: true, result: undefined, late: undefined, disposed: 1, count: 0 });
  });
}

test('renderer teardown completes even if a pending creation fails', async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const registry = (window as any).surfaces.createWebProjectionSurfaces();
      let fail!: (reason: Error) => void;
      const creation = registry
        .ensure(
          document,
          () =>
            new Promise((_resolve, reject) => {
              fail = reject;
            }),
        )
        .catch(() => 'failed');
      await Promise.resolve();
      const cleanup = registry.destroy();
      fail(new Error('Creation unavailable'));
      await cleanup;
      return { creation: await creation, surfaces: registry.values().length };
    }),
  ).toEqual({ creation: 'failed', surfaces: 0 });
});

test('teardown waits for a deletion already in progress', async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const registry = (window as any).surfaces.createWebProjectionSurfaces();
      const owner = document.querySelector('main')!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let disposed = false;
      await registry.ensure(owner, async () => ({
        destroy: async () => {
          await gate;
          disposed = true;
        },
      }));
      const removal = registry.delete(owner);
      let finished = false;
      const teardown = registry.destroy().then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const finishedBeforeDisposal = finished;
      release();
      await Promise.all([removal, teardown]);
      return { finishedBeforeDisposal, disposed };
    }),
  ).toEqual({ finishedBeforeDisposal: false, disposed: true });
});
