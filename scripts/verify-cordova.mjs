import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Real Cordova consumers, isolated from any application or published Engine version.
const [platform, device] = process.argv.slice(2);
assert(['android', 'ios'].includes(platform) && device, 'Usage: npm run test:cordova -- android|ios DEVICE_ID');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'native-ui-engine-cordova-'));
const app = join(directory, 'app');
const version = `0.0.0-verification.${Date.now()}`;
const env = {
  ...process.env,
  NATIVE_UI_ENGINE_SOURCE: root,
  NATIVE_UI_ENGINE_REPOSITORY: join(root, 'android/build/maven'),
  NATIVE_UI_ENGINE_VERSION: version,
};
const run = (command, args, cwd = app, capture = false) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
const cordova = (...args) =>
  run('npx', ['--yes', '--package=cordova@13.0.0', 'cordova', ...args, '--no-telemetry'], existsSync(app) ? app : directory);
console.log(`Cordova verification artifacts: ${directory}`);
run('npm', ['run', 'build'], root);
cordova('create', app, 'dev.rdlabo.engine.cordova', 'EngineCordova');
const config = join(app, 'config.xml');
writeFileSync(
  config,
  readFileSync(config, 'utf8').replace(
    '</widget>',
    '<preference name="GradlePluginKotlinEnabled" value="true"/><preference name="GradlePluginKotlinVersion" value="2.2.20"/><preference name="deployment-target" value="15.0"/></widget>',
  ),
);
cpSync(join(root, 'tests/cordova/www'), join(app, 'www'), { recursive: true });
cordova('platform', 'add', platform === 'android' ? 'android@15.1.0' : 'ios@8.1.1');
cordova('plugin', 'add', join(root, 'tests/cordova/plugin'));
cordova('prepare', platform);
const identifier = 'dev.rdlabo.engine.cordova';
let result;
if (platform === 'android') {
  const init = join(directory, 'version.gradle');
  writeFileSync(
    init,
    `allprojects { afterEvaluate { version = '${version}'; publishing.publications.each { it.version = project.version } } }`,
  );
  const gradle = join(root, 'android/gradlew');
  run(gradle, ['-p', join(root, 'android'), '-I', init, 'publishReleasePublicationToVerificationRepository']);
  run(gradle, ['-p', 'platforms/android', 'assembleDebug']);
  const adb = process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools/adb') : 'adb';
  const command = (...args) => run(adb, ['-s', device, ...args], app, true);
  command('install', '-r', join(app, 'platforms/android/app/build/outputs/apk/debug/app-debug.apk'));
  command('shell', 'am', 'force-stop', identifier);
  command('shell', 'run-as', identifier, 'rm', '-f', 'files/engine-result.json');
  command('shell', 'am', 'start', '-n', `${identifier}/.MainActivity`);
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      result = JSON.parse(command('shell', 'run-as', identifier, 'cat', 'files/engine-result.json'));
      break;
    } catch {}
    await delay(500);
  }
} else {
  run('xcodebuild', [
    '-workspace',
    'platforms/ios/App.xcworkspace',
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-sdk',
    'iphonesimulator',
    '-destination',
    `platform=iOS Simulator,id=${device}`,
    '-derivedDataPath',
    join(directory, 'build'),
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ]);
  const command = (...args) => run('xcrun', ['simctl', ...args], app, true);
  command('install', device, join(app, 'platforms/ios/build/Debug-iphonesimulator/EngineCordova.app'));
  const container = command('get_app_container', device, identifier, 'data').trim();
  const report = join(container, 'tmp/engine-result.json');
  if (existsSync(report)) unlinkSync(report);
  try {
    command('terminate', device, identifier);
  } catch {}
  command('launch', device, identifier);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (existsSync(report)) {
      result = JSON.parse(readFileSync(report, 'utf8'));
      break;
    }
    await delay(500);
  }
}
writeFileSync(join(directory, 'result.json'), JSON.stringify(result ?? { error: 'No result' }, null, 2));
assert(
  result?.passed && result.capacitorAbsent && result.cycles >= 6 && result.reloaded,
  JSON.stringify(result ?? 'Cordova app did not report completion'),
);
console.log(JSON.stringify(result));
