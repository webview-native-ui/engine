import { getOverlayCoordinator } from '../dom/overlays.js';

const key = Symbol.for('@webview-native-ui/engine/projection-pause/v1');
const createPause = (doc: Document) => {
  const overlays = getOverlayCoordinator(doc);
  const listeners = new Set<() => void>();
  let depth = 0;
  const change = (delta: number) => {
    const paused = depth > 0;
    depth = Math.max(0, depth + delta);
    if (paused === depth > 0) return;
    for (const listener of listeners) listener();
  };
  return {
    // Without a target, only the document-wide request applies; renderers own local coverage.
    isPaused: (target?: HTMLElement) => depth > 0 || (!!target && overlays.isCovered(target)),
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

/** Release one pause; normal per-surface presentation resumes after the last release. */
export const resume = (): void => getProjectionPause(document).resume();
