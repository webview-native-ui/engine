import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const runtime = new URL('../runtime/native-ui-engine.js', import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL('../src/native/bootstrap.ts', import.meta.url))],
  outfile: fileURLToPath(runtime),
  bundle: true,
  format: 'iife',
  globalName: 'WebViewNativeUIEngineRuntime',
  minify: true,
  target: ['safari15', 'chrome100'],
});

// SwiftPM resources must live inside the Swift target; ship a generated copy.
await mkdir(new URL('../ios/Sources/WebViewNativeUIEngine/Resources/', import.meta.url), { recursive: true });
await copyFile(runtime, new URL('../ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js', import.meta.url));
