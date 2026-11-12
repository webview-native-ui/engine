import type { ListenerHandle as PluginListenerHandle } from '../types.js';

// A failed bridge must not leave the source inaccessible indefinitely.
export const bounded = <T>(promise: Promise<T>, waitMs = 0): Promise<T> =>
  new Promise((resolve, reject) => {
    const expire = () => reject(new Error('Native UI bridge timed out'));
    // Keep the configured wait separate so adding the processing budget cannot
    // overflow the browser's maximum timer interval.
    let timer =
      waitMs > 0
        ? setTimeout(() => {
            timer = setTimeout(expire, 5000);
          }, waitMs)
        : setTimeout(expire, 5000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/** A timed-out registration still owns a native resource if it eventually succeeds. */
export const boundedListener = async (registration: Promise<PluginListenerHandle>): Promise<PluginListenerHandle> => {
  try {
    return await bounded(registration);
  } catch (error) {
    void registration.then((listener) => listener.remove()).catch(() => {});
    throw error;
  }
};
