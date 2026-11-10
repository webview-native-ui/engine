#!/usr/bin/env python3
"""Reproduce fresh-capture comparisons using temporary copies of production sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import statistics
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/performance/fresh'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('platform', choices=['ios', 'android', 'summarize'])
p.add_argument('--device', help='Required iOS simulator UUID; Android is fixed to emulator-5554')
p.add_argument('--output', type=Path, required=True, help='Raw output JSON, or input JSON for summarize')
p.add_argument('--timeout', type=int, default=240)
p.add_argument('--prepare-only', action='store_true', help='Generate and compile without installing or running')
args = p.parse_args()

def run(*cmd):
    return subprocess.check_output([str(x) for x in cmd], cwd=ROOT, text=True, timeout=args.timeout + 120).strip()

def replace_once(text, before, after):
    assert text.count(before) == 1, f'Production instrumentation anchor changed: {before}'
    return text.replace(before, after, 1)

def summarize(rows):
    for mode in sorted({r['mode'] for r in rows}):
        measured = [r for r in rows if r['mode'] == mode and r['trial'] >= 3]
        assert len(measured) == 30, (mode, len(measured))
        values = sorted(r['total_ms'] for r in measured)
        print(json.dumps({'mode': mode, 'samples': len(values), 'total_p50_ms': statistics.median(values),
                          'total_p90_ms': values[26], 'bytes_p50': statistics.median(r['bytes'] for r in measured)}))

if args.platform == 'summarize':
    summarize(json.loads(args.output.read_text()))
    raise SystemExit
args.output = args.output.resolve()
source_hashes = {}
fixture_hashes = {str(f.relative_to(ROOT)): hashlib.sha256(f.read_bytes()).hexdigest() for f in FIXTURE.rglob('*') if f.is_file()}
manifest_hash = hashlib.sha256((ROOT / 'native/artifacts/all-build.json').read_bytes()).hexdigest()
def source(relative):
    raw = (ROOT / relative).read_bytes()
    source_hashes[relative] = hashlib.sha256(raw).hexdigest()
    return raw.decode()

with tempfile.TemporaryDirectory(prefix='native-png-bench-') as tmp:
    folder = Path(tmp)
    if args.platform == 'ios':
        if not args.prepare_only and not args.device:
            p.error('--device must identify an iOS simulator')
        app = folder / 'ScreenBench.app'
        app.mkdir()
        capture = source('ios/Sources/WebViewNativeUIEngine/CoveredSnapshots.swift')
        before = '''pngEncoder.encode(CIImage(cgImage: pixels), colorSpace: outputSpace) ??
                            imageContext.pngRepresentation(of: CIImage(cgImage: pixels), format: .RGBA16,
                                                                   colorSpace: outputSpace, options: [:])'''
        capture = replace_once(capture, before, 'benchmarkPNG(CIImage(cgImage: pixels), colorSpace: outputSpace, platform: imageContext, rust: pngEncoder)')
        (folder / 'Capture.swift').write_text(capture)
        encoder = source('ios/Sources/WebViewNativeUIEngine/NativeUIPngEncoder.swift')
        (folder / 'Encoder.swift').write_text(encoder)
        library = ROOT / 'native/artifacts/NativeUIPng.xcframework/ios-arm64_x86_64-simulator/libnative_ui_png.a'
        run('xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-O', '-parse-as-library', '-target', platform.machine() + '-apple-ios27.0-simulator', '-module-cache-path', folder / 'modules', '-I', ROOT / 'native/include', FIXTURE / 'ios.swift', folder / 'Capture.swift', folder / 'Encoder.swift', library, '-o', app / 'ScreenBench')
        bundle = 'local.native.pngbench'
        info = {'CFBundleIdentifier': bundle, 'CFBundleExecutable': 'ScreenBench', 'CFBundleName': 'ScreenBench', 'CFBundlePackageType': 'APPL', 'MinimumOSVersion': '27.0', 'UILaunchScreen': {}, 'UIApplicationSceneManifest': {'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{'UISceneConfigurationName': 'Default', 'UISceneDelegateClassName': 'ScreenBench.Scene'}]}}}
        (app / 'Info.plist').write_bytes(plistlib.dumps(info))
        metadata = {'sdk': run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version'), 'device': args.device}
        if not args.prepare_only:
            devices = json.loads(run('xcrun', 'simctl', 'list', 'devices', '-j'))
            metadata['simulator'] = next({'runtime': runtime, **d} for runtime, values in devices['devices'].items() for d in values if d['udid'] == args.device)
            run('xcrun', 'simctl', 'install', args.device, app)
            container = Path(run('xcrun', 'simctl', 'get_app_container', args.device, bundle, 'data'))
            result = container / 'Documents/screen-results.json'
            error = container / 'Documents/error.txt'
            result.unlink(missing_ok=True)
            error.unlink(missing_ok=True)
            run('xcrun', 'simctl', 'launch', args.device, bundle)
            def read_result():
                if error.exists():
                    raise RuntimeError(error.read_text())
                return result.read_text() if result.exists() else None
    else:
        if args.device and args.device != 'emulator-5554':
            p.error('Android runs are restricted to emulator-5554')
        os.environ['ANDROID_SERIAL'] = 'emulator-5554'
        sdk = Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', str(Path.home() / 'Library/Android/sdk'))))
        adb = sdk / 'platform-tools/adb'
        def device(*cmd):
            return run(adb, '-s', 'emulator-5554', *cmd)
        project = folder / 'android'
        java = project / 'app/src/main/java/io/github/webview_native_ui/engine'
        java.mkdir(parents=True)
        shutil.copy(FIXTURE / 'android/settings.gradle', project / 'settings.gradle')
        shutil.copy(FIXTURE / 'android/build.gradle', project / 'app/build.gradle')
        shutil.copy(FIXTURE / 'android/AndroidManifest.xml', project / 'app/src/main/AndroidManifest.xml')
        shutil.copy(FIXTURE / 'android/MainActivity.kt', java)
        (project / 'gradle.properties').write_text('android.useAndroidX=true\n')
        (project / 'local.properties').write_text('sdk.dir=' + str(sdk) + '\n')
        for name in ['NativeUIPng.kt', 'NativeUIWebReadiness.kt', 'NativeUISnapshots.kt']:
            text = source('android/src/main/java/io/github/webview_native_ui/engine/' + name)
            if name == 'NativeUISnapshots.kt':
                text = replace_once(text, 'NativeUIPng.write(image, it)', 'NativeEncoder.write(image, it)')
            (java / name).write_text(text)
        shutil.copytree(ROOT / 'native/artifacts/android', project / 'app/src/main/jniLibs')
        run(ROOT / 'android/gradlew', '-p', project, 'assembleRelease')
        metadata = {'device': 'emulator-5554'}
        if not args.prepare_only:
            assert device('shell', 'getprop', 'ro.kernel.qemu') == '1', 'Target must be an emulator'
            metadata.update({'sdk': device('shell', 'getprop', 'ro.build.version.sdk'), 'size': device('shell', 'wm', 'size'), 'density': device('shell', 'wm', 'density')})
            bundle = 'local.snapshot.android'
            device('install', '-r', project / 'app/build/outputs/apk/release/app-release.apk')
            device('shell', 'am', 'force-stop', bundle)
            device('shell', 'run-as', bundle, 'rm', '-f', 'files/screen-results.json', 'files/error.txt')
            device('shell', 'am', 'start', '-n', bundle + '/io.github.webview_native_ui.engine.MainActivity')
            def read_result():
                files = device('shell', 'run-as', bundle, 'ls', 'files')
                if 'error.txt' in files:
                    raise RuntimeError(device('shell', 'run-as', bundle, 'cat', 'files/error.txt'))
                return device('shell', 'run-as', bundle, 'cat', 'files/screen-results.json') if 'screen-results.json' in files else None
    if args.prepare_only:
        print('Fixture generation and compilation passed; no app installed or launched.')
        raise SystemExit
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        raw = read_result()
        if raw:
            rows = json.loads(raw)
            summarize(rows)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(rows, indent=2) + '\n')
            metadata['sources'] = source_hashes
            metadata['native_manifest_sha256'] = manifest_hash
            metadata['host'] = platform.platform()
            metadata['git_head'] = run('git', 'rev-parse', 'HEAD')
            metadata['fixture_sha256'] = fixture_hashes
            args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
            break
        time.sleep(0.5)
    else:
        raise SystemExit('Fresh PNG benchmark timed out; inspect simulator/emulator logs')
