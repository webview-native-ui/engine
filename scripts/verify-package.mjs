import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'engine-package-'));
try {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '.', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }),
  );
  const archive = join(directory, packed.filename);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  assert.deepEqual(
    execFileSync('tar', ['-xOf', archive, 'package/ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js']),
    readFileSync('runtime/native-ui-engine.js'),
    'The shipped Swift runtime must match the shared native runtime',
  );
  assert.equal(manifest.name, '@webview-native-ui/engine');
  assert.equal(manifest.capacitor, undefined);
  assert.equal(manifest.license, 'MIT');
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of [
    'LICENSE',
    'README.md',
    'WebViewNativeUIEngine.podspec',
    'ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js',
  ])
    assert(files.has(file), file);
  for (const entry of Object.values(manifest.exports))
    for (const path of Object.values(entry)) assert(files.has(path.replace(/^\.\//, '')), path);
  assert(!files.has('Package.swift'), 'SwiftPM resolves from Git');
  assert(![...files].some((file) => /^(tests|android|node_modules)\//.test(file)));
  console.log('npm archive: exports, native resources and license verified');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
