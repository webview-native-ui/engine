import { getOverlayCoordinator } from '../dom/overlays.js';

const key = Symbol.for('@webview-native-ui/engine/projection-pause/v1');
const createPause = (doc: Document) => {
  const overlays = getOverlayCoordinator(doc);
  const listeners = new Set<() => void>();
  let depth = 0;
  let releaseFrame = 0;
  const paused = () => depth > 0 || releaseFrame !== 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const change = (delta: number) => {
    if (delta < 0 && depth === 0) return;
    const wasPaused = paused();
    depth += delta;
    const win = doc.defaultView;
    if (releaseFrame && win) {
      win.cancelAnimationFrame(releaseFrame);
      releaseFrame = 0;
    }
    if (depth === 0 && win) {
      // Give DOM dismissal a paint opportunity before requesting Native return.
      // Keep all consumers paused meanwhile, including Ionic change callbacks.
      releaseFrame = win.requestAnimationFrame(() => {
        releaseFrame = win.requestAnimationFrame(() => {
          releaseFrame = 0;
          notify();
        });
      });
    } else if (wasPaused !== paused()) notify();
  };
  return {
    // Without a target, only the document-wide request applies; renderers own local coverage.
    isPaused: (target?: HTMLElement) => paused() || (!!target && overlays.isCovered(target)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stopOverlays = overlays.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stopOverlays();
      };
    },
    pause: () => change(1),
    resume: () => change(-1),
  };
};

export const getProjectionPause = (doc: Document) => {
  const shared = doc as unknown as Record<symbol, ReturnType<typeof createPause>>;
  return (shared[key] ??= createPause(doc));
};

/** Request temporary Web projection across this document. Pair each call with resume(). */
export const pause = (): void => getProjectionPause(document).pause();

/** Release one shared pause, regardless of caller; resume exactly once per pause(). */
export const resume = (): void => getProjectionPause(document).resume();
