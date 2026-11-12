import { createWebProjectionSurface } from '../../../src/projection/surface';
let serial = 0;
const replies = new Map<number, (value: any) => void>();
const native = (request: any): Promise<any> =>
  new Promise((resolve) => {
    const key = ++serial;
    replies.set(key, resolve);
    (window as any).webkit.messageHandlers.bridge.postMessage({ key, request });
  });
let interaction = (_event: any) => {};
Object.assign(window, {
  Capacitor: { convertFileSrc: (url: string) => url.replace('file://', 'snapshot://local') },
  receive: (key: number, result: any) => {
    replies.get(key)?.(result);
    replies.delete(key);
  },
  interaction: (event: any) => interaction(event),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function trial(mode: string, index: number) {
  await native({ action: 'reset' });
  const data: any = { mode, index, timings: [] };
  let finish!: () => void;
  const painted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let contacted = false;
  const contact = async () => {
    if (contacted) return;
    contacted = true;
    await native({ action: 'contact' }); // Controlled race, separately from real UIWindow events.
    manager.begin();
  };
  const record = (event: Event) => {
    data.timings.push((event as CustomEvent).detail);
    if (mode === 'ready' && !contacted && (event as CustomEvent).detail.requestToReadyMs !== undefined) void contact();
  };
  window.addEventListener('production:capture-timing', record);
  const manager = await createWebProjectionSurface(
    {
      send: async (request) => {
        const result = native(request);
        if (request.action === 'prepare' && !contacted && mode !== 'ready') setTimeout(() => void contact(), mode === 'waiting' ? 0 : 110);
        const value = await result;
        if (request.action === 'painted') finish();
        return value;
      },
      listen: async (listener) => {
        interaction = (event) => {
          data.events ??= [];
          data.events.push(event);
          listener(event);
        };
        await native({ action: 'observe' });
        return {
          remove: () => {
            interaction = () => {};
          },
        };
      },
    },
    { namespace: 'production', target: ({ element }) => element, wake: () => {}, blocked: () => false, captureDelayMs: 50 },
  );
  const sources = ['top', 'bottom'].map((id) => {
    const element = document.getElementById(id)!;
    const frame = element.getBoundingClientRect();
    return { element, control: { id, x: frame.x, y: frame.y, width: frame.width, height: frame.height } };
  });
  manager.consider(1, sources);
  await Promise.race([
    painted,
    sleep(5000).then(() => {
      throw new Error(`Handoff timed out: ${mode}`);
    }),
  ]);
  data.token = manager.token;
  window.removeEventListener('production:capture-timing', record);
  await manager.destroy();
  await native({ action: 'record', data });
  await sleep(100);
}
(async () => {
  await native({ action: 'layout' });
  await sleep(300);
  for (let index = 0; index < 12; index++) for (const mode of ['ready', 'waiting', 'processing']) await trial(mode, index);
  await native({ action: 'done' });
})().catch((error) => native({ action: 'error', message: String(error) }));
