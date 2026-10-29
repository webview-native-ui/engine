/** Send only replaceable state from an update pass, never user actions. */
export type NativeUpdateSender = <T>(request: () => Promise<T>, validate?: (result: T) => void) => Promise<T | undefined>;

/** Coalesce current-state reads and serialize them across asynchronous native acknowledgements. */
export const createNativeUpdateQueue = (
  window: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  options: {
    update(send: NativeUpdateSender): Promise<void>;
    failed(error: unknown): void | Promise<void>;
    retry(): void;
    reconnect?: boolean;
  },
) => {
  let frame = 0;
  let dirty = false;
  let running = false;
  let stopped = false;
  let retrying = false;
  let waiting = false;
  let reconciled = false;
  const request = () => {
    if (stopped) return;
    dirty = true;
    if (!running && !waiting && !frame) frame = window.requestAnimationFrame(() => void run());
  };
  const waitForConnection = (error: unknown) => {
    if (!options.reconnect || reconciled) throw error;
    waiting = true;
    dirty = false;
  };
  const send: NativeUpdateSender = async (operation, validate) => {
    if (stopped || waiting) return;
    let result;
    try {
      result = await operation();
    } catch (error) {
      if (stopped) return;
      if (retrying) waitForConnection(error);
      else {
        retrying = true;
        options.retry();
        request();
      }
      return;
    }
    if (stopped) return;
    try {
      validate?.(result);
    } catch (error) {
      waitForConnection(error);
      return;
    }
    retrying = waiting = reconciled = false;
    return result;
  };
  const run = async () => {
    frame = 0;
    if (stopped || waiting) return;
    dirty = false;
    running = true;
    try {
      await options.update(send);
    } catch (error) {
      if (stopped) return;
      // Retire the queue before reporting terminal failure; no late update can restart it.
      stopped = true;
      await options.failed(error);
    } finally {
      running = false;
      if (dirty) request();
    }
  };
  return {
    request,
    get dirty() {
      return dirty;
    },
    get running() {
      return running;
    },
    get waiting() {
      return waiting;
    },
    reconnected() {
      if (stopped) return;
      if (waiting) {
        reconciled = true;
        retrying = waiting = false;
      }
      request();
    },
    destroy() {
      stopped = true;
      dirty = false;
      window.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
};
