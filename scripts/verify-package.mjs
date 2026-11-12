import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
execFileSync('python3', ['scripts/verify-native-png.py'], { stdio: 'inherit' });
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
    'WebViewNativeUIControls.podspec',
    'native/artifacts/NativeUIPng.xcframework/Info.plist',
    'ios/Sources/WebViewNativeUIEngine/Resources/NativeUIPngLicenses/dependencies.json',
    'ios/Sources/WebViewNativeUIControls/NativeUIController.swift',
    'ios/Sources/WebViewNativeUIEngine/CoveredSnapshots.swift',
    'ios/Sources/WebViewNativeUIEngine/CapturePlanner.swift',
    'ios/Sources/WebViewNativeUIEngine/SnapshotEventInterception.swift',
    'ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js',
  ])
    assert(files.has(file), file);
  assert(!files.has('native/licenses/dependencies.json'), 'Rust notices must have one canonical source');
  for (const entry of Object.values(manifest.exports))
    for (const path of Object.values(entry)) assert(files.has(path.replace(/^\.\//, '')), path);
  assert(![...files].some((file) => file.startsWith('docs/validation/')), 'Measurement evidence stays in Git, outside the npm archive');
  assert(files.has('docs/advanced/preinteraction-capture.md'), 'Ship the integration guide');
  assert(!files.has('Package.swift'), 'SwiftPM resolves from Git');
  assert(![...files].some((file) => /^(tests|android|node_modules)\//.test(file)));
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  for (const base of ['ios/Sources/WebViewNativeUIEngine/Resources/NativeUIPngLicenses', 'native/licenses'])
    for (const name of readdirSync(base))
      assert.deepEqual(readFileSync(join(directory, 'package', base, name)), readFileSync(join(base, name)));
  // Import the extracted archive without installing Capacitor, Ionic, or other dependencies.
  const controls = await import(pathToFileURL(join(directory, 'package/dist/controls/index.js')));
  const integration = await import(pathToFileURL(join(directory, 'package/dist/integration/index.js')));
  assert.equal(typeof controls.createNativeUI, 'function');
  assert.equal(typeof integration.suspendNativeUI, 'function');
  console.log('npm archive: exports, native resources and license verified');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
