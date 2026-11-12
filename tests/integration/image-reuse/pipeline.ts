import { createWebProjectionBatch, createWebProjectionScope } from '../../../src/index.js';

const win = window as unknown as {
  webkit: { messageHandlers: { bridge: { postMessage(value: unknown): void } } };
  reply(key: number, value: unknown): void;
  Capacitor: { convertFileSrc(url: string): string };
};
const replies = new Map<number, (value: any) => void>();
let serial = 0;
let phase = 'startup';
let state: () => unknown = () => ({});
const trace: unknown[] = [];
const send = (request: Record<string, unknown>): Promise<any> =>
  new Promise((resolve) => {
    const key = ++serial;
    const sentAt = performance.now();
    trace.push({ key, action: request.action, sentAt });
    replies.set(key, (value) => {
      trace.push({ key, action: request.action, response: value, elapsedMs: performance.now() - sentAt });
      resolve(value);
    });
    win.webkit.messageHandlers.bridge.postMessage({ key, request });
  });
win.reply = (key, value) => {
  replies.get(key)?.(value);
  replies.delete(key);
};
win.Capacitor = { convertFileSrc: (url) => url.replace('file://', 'snapshot://local') };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (stage: string, test: () => boolean) => {
  phase = stage;
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > 5000) throw new Error(`pipeline timed out: ${stage}`);
    await delay(10);
  }
};

async function run() {
  let decodes = 0;
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    decodes++;
    return decode.call(this);
  };
  const frames = await send({ action: 'frames' });
  const sources = frames.map((frame: any, index: number) => {
    const element = document.createElement('div');
    element.style.cssText = `position:fixed;left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px`;
    document.body.append(element);
    return { element, scope: createWebProjectionScope(element, 'pipeline'), control: { id: String(index), ...frame } };
  });
  let revision = 1,
    adoptions = 0;
  window.addEventListener('pipeline:sources-change', () => adoptions++);
  const manager = await createWebProjectionBatch(
    {
      send: (request) => send({ ...request, ...(request.action === 'prepare' ? { captureMode: 'view' } : {}) }),
      listen: async () => ({ remove() {} }),
    },
    { captureDelayMs: 0, wake() {}, blocked: () => false, captureRevision: () => revision, transient: true, imageSurface: document.body },
  );
  state = () => ({ adoptions, token: manager.token, restoring: manager.restoring });
  const checkpoints: unknown[] = [];
  const record = async (stage: string) => checkpoints.push({ stage, decodes, ...(await send({ action: 'metrics' })) });
  manager.consider(1, sources);
  await wait('empty-cache-adoption', () => adoptions === 1);
  await record('empty-cache');
  for (let i = 0; i < 3; i++) {
    const previous = adoptions;
    const moved = await send({ action: 'move' });
    sources.forEach((source: any, index: number) => {
      source.element.style.top = `${moved[index].y}px`;
      source.control.y = moved[index].y;
    });
    manager.consider(1, sources);
    manager.changed();
    await wait(`move-${i}-adoption`, () => adoptions > previous);
  }
  await record('same-content-three-prepares');
  // Exercise the entry/return protocol without changing the artwork.
  manager.begin();
  await wait('entry-token', () => !!manager.token);
  await delay(100);
  manager.end();
  await wait('restore-start', () => manager.restoring);
  await send({ action: 'accept-native' });
  manager.updated(
    undefined,
    sources.map((s) => s.control.id),
    2,
  );
  await wait('restore-complete', () => !manager.restoring);
  await delay(100);
  await record('entry-return');
  const previous = adoptions;
  await send({ action: 'content' });
  revision++;
  manager.changed();
  await wait('changed-adoption', () => adoptions > previous);
  await record('content-changed');
  await manager.destroy();
  await send({ action: 'reset' });
  await record('destroy-reset');
  await send({ action: 'done', checkpoints });
}
void run().catch((error) => send({ action: 'failed', error: String(error), phase, state: state(), pending: [...replies.keys()], trace }));
