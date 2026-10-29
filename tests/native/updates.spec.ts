import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
const bundle = buildSync({ entryPoints: ['src/index.ts'], bundle: true, format: 'iife', globalName: 'engine', write: false }).outputFiles[0]
  .text;

test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ content: bundle });
});

test('coalesces fresh state, never overlaps passes, and ignores completion after disposal', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.sent = [];
    w.value = 1;
    w.completions = [];
    w.applied = [];
    w.queue = w.engine.createNativeUpdateQueue(window, {
      async update(send: any) {
        const value = w.value;
        const result = await send(
          () =>
            new Promise((resolve) => {
              w.sent.push(value);
              w.completions.push(() => resolve(value));
            }),
        );
        if (result !== undefined) w.applied.push(result);
      },
      retry() {},
      failed(error: unknown) {
        throw error;
      },
    });
    w.queue.request();
    w.queue.request();
  });
  await expect.poll(() => page.evaluate(() => (window as any).sent)).toEqual([1]);
  await page.evaluate(() => {
    const w = window as any;
    w.value = 2;
    w.queue.request();
    w.value = 3;
    w.queue.request();
  });
  expect(await page.evaluate(() => (window as any).sent)).toEqual([1]);
  await page.evaluate(() => (window as any).completions.shift()());
  await expect.poll(() => page.evaluate(() => (window as any).sent)).toEqual([1, 3]);
  await page.evaluate(() => {
    const w = window as any;
    w.queue.destroy();
    w.completions.shift()();
    w.queue.request();
  });
  expect(await page.evaluate(() => ({ sent: (window as any).sent, applied: (window as any).applied }))).toEqual({
    sent: [1, 3],
    applied: [1],
  });
});

for (const reconnect of [false, true]) {
  test(`failed updates reread once, then ${reconnect ? 'wait for reconnection' : 'stop'}`, async ({ page }) => {
    await page.evaluate((reconnect) => {
      const w = window as any;
      w.sent = [];
      w.failures = 0;
      w.retries = 0;
      w.value = 1;
      w.queue = w.engine.createNativeUpdateQueue(window, {
        reconnect,
        async update(send: any) {
          await send(async () => {
            w.sent.push(w.value);
            throw new Error('offline');
          });
        },
        retry() {
          w.retries++;
          w.value++;
        },
        failed() {
          w.failures++;
        },
      });
      w.queue.request();
    }, reconnect);
    await expect.poll(() => page.evaluate(() => (window as any).sent.length)).toBe(2);
    expect(
      await page.evaluate(() => ({ sent: (window as any).sent, retries: (window as any).retries, waiting: (window as any).queue.waiting })),
    ).toEqual({ sent: [1, 2], retries: 1, waiting: reconnect });
    if (reconnect) {
      await page.evaluate(() => {
        const w = window as any;
        w.value = 3;
        w.queue.request();
      });
      expect(await page.evaluate(() => (window as any).sent)).toEqual([1, 2]);
      await page.evaluate(() => {
        const queue = (window as any).queue;
        queue.reconnected();
        queue.reconnected();
      });
      await expect.poll(() => page.evaluate(() => (window as any).failures)).toBe(1);
      expect(await page.evaluate(() => (window as any).sent)).toEqual([1, 2, 3, 4]);
    } else await expect.poll(() => page.evaluate(() => (window as any).failures)).toBe(1);
    await page.evaluate(() => {
      const q = (window as any).queue;
      q.request();
      q.reconnected();
      q.destroy();
    });
  });
}

test('mismatched acknowledgement waits for reconciliation and success resets the recovery budget', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.attempt = 0;
    w.accept = false;
    w.mode = 'reply';
    w.retries = 0;
    w.failures = 0;
    w.queue = w.engine.createNativeUpdateQueue(window, {
      reconnect: true,
      async update(send: any) {
        await send(
          async () => {
            w.attempt++;
            if (w.mode === 'reject') throw new Error('offline');
            return 1;
          },
          () => {
            if (!w.accept) throw new Error('Revision mismatch');
          },
        );
      },
      retry() {
        w.retries++;
      },
      failed() {
        w.failures++;
      },
    });
    w.queue.request();
  });
  await expect.poll(() => page.evaluate(() => (window as any).queue.waiting)).toBe(true);
  expect(await page.evaluate(() => (window as any).attempt)).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.accept = true;
    w.queue.reconnected();
  });
  await expect.poll(() => page.evaluate(() => (window as any).attempt)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).queue.running)).toBe(false);
  await page.evaluate(() => {
    const w = window as any;
    w.mode = 'reject';
    w.queue.request();
  });
  await expect.poll(() => page.evaluate(() => (window as any).queue.waiting)).toBe(true);
  expect(
    await page.evaluate(() => ({
      attempts: (window as any).attempt,
      retries: (window as any).retries,
      failures: (window as any).failures,
    })),
  ).toEqual({ attempts: 4, retries: 1, failures: 0 });
  await page.evaluate(() => (window as any).queue.destroy());
});

test('disposal suppresses a late state-read failure', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.failures = 0;
    w.queue = w.engine.createNativeUpdateQueue(window, {
      update: () =>
        new Promise((_, reject) => {
          w.rejectRead = reject;
        }),
      retry() {},
      failed() {
        w.failures++;
      },
    });
    w.queue.request();
  });
  await expect.poll(() => page.evaluate(() => (window as any).queue.running)).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.queue.destroy();
    w.rejectRead(new Error('Reader disposed'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).queue.running)).toBe(false);
  expect(await page.evaluate(() => (window as any).failures)).toBe(0);
});

for (const failedIndex of [0, 1]) {
  test(`a failure in sequential send ${failedIndex + 1} cannot be masked by another successful send`, async ({ page }) => {
    const result = await page.evaluate(async (failedIndex) => {
      const frames: FrameRequestCallback[] = [];
      const attempts: number[] = [];
      let retries = 0;
      let failures = 0;
      const queue = (window as any).engine.createNativeUpdateQueue(
        {
          requestAnimationFrame(callback: FrameRequestCallback) {
            frames.push(callback);
            return frames.length;
          },
          cancelAnimationFrame() {},
        },
        {
          reconnect: true,
          async update(send: any) {
            for (const index of [0, 1])
              await send(async () => {
                attempts.push(index);
                if (index === failedIndex) throw new Error('offline');
                return true;
              });
          },
          retry() {
            retries++;
          },
          failed() {
            failures++;
          },
        },
      );
      const flush = async () => {
        for (let i = 0; i < 10 && frames.length; i++) {
          frames.shift()!(0);
          while (queue.running) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      queue.request();
      await flush();
      const waiting = queue.waiting;
      queue.reconnected();
      await flush();
      queue.destroy();
      return { attempts, retries, failures, waiting, pending: frames.length };
    }, failedIndex);
    expect(result).toEqual({
      attempts: failedIndex === 0 ? [0, 0, 0, 0] : [0, 1, 0, 1, 0, 1, 0, 1],
      retries: 2,
      failures: 1,
      waiting: true,
      pending: 0,
    });
  });
}
