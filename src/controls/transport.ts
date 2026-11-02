import type { NativeUIPlugin } from './definitions.js';

/** Host bridge supplied by Capacitor, Cordova, or another embedding runtime. */
export interface NativeUITransport {
  readonly plugin: NativeUIPlugin;
  getPlatform(): string;
  isAvailable(): boolean;
}
export interface NativeUIListenerHandle {
  remove(): Promise<void>;
}
