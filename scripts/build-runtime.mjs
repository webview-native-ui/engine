import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: [fileURLToPath(new URL('../src/native/bootstrap.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  globalName: 'WebViewNativeUIEngineRuntime',
  minify: true,
  target: ['safari15', 'chrome100'],
});
