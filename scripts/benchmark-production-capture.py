#!/usr/bin/env python3
"""Build unmodified working-tree capture code and exercise the production Web handoff."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--device', required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--planner', action='store_true')
p.add_argument('--planner-verify', action='store_true')
a = p.parse_args()
def run(*args):
    return subprocess.check_output([str(arg) for arg in args], cwd=ROOT, text=True).strip()
sources = [ROOT / 'ios/Sources/WebViewNativeUIEngine' / name for name in ('CoveredSnapshots.swift', 'NativeUIPngEncoder.swift', 'CapturePlanner.swift', 'SnapshotEventInterception.swift')]
fixture = ROOT / 'tests/performance/preinteraction'
files = sources + [fixture / 'production.swift', fixture / 'planner.swift', fixture / 'production.ts', ROOT / 'src/projection/web.ts', ROOT / 'src/types.ts']
input_hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
with tempfile.TemporaryDirectory(prefix='production-capture-') as directory:
    folder = Path(directory)
    app = folder / 'ProductionCapture.app'
    app.mkdir()
    run(ROOT / 'node_modules/.bin/esbuild', fixture / 'production.ts', '--bundle', '--format=iife', '--target=safari15', '--outfile=' + str(app / 'production.js'))
    run('xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-O', '-parse-as-library', '-target', platform.machine() + '-apple-ios27.0-simulator', '-module-cache-path', folder / 'modules', '-I', ROOT / 'native/include', *sources, fixture / 'production.swift', fixture / 'planner.swift', ROOT / 'native/artifacts/NativeUIPng.xcframework/ios-arm64_x86_64-simulator/libnative_ui_png.a', '-lz', '-o', app / 'ProductionCapture')
    bundle = 'local.native.productioncapture'
    info = {'CFBundleIdentifier': bundle, 'CFBundleExecutable': 'ProductionCapture', 'CFBundleName': 'Production Capture', 'CFBundlePackageType': 'APPL', 'MinimumOSVersion': '27.0', 'UILaunchScreen': {}, 'UIApplicationSceneManifest': {'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{'UISceneConfigurationName': 'Default', 'UISceneDelegateClassName': 'ProductionCapture.ProductionScene'}]}}}
    (app / 'Info.plist').write_bytes(plistlib.dumps(info))
    run('xcrun', 'simctl', 'install', a.device, app)
    container = Path(run('xcrun', 'simctl', 'get_app_container', a.device, bundle, 'data'))
    result = container / ('Documents/planner-results.json' if a.planner else 'Documents/production-results.json')
    result.unlink(missing_ok=True)
    run('xcrun', 'simctl', 'launch', a.device, bundle, *(['--planner'] if a.planner else []), *(['--planner-verify'] if a.planner_verify else []))
    deadline = time.monotonic() + (600 if a.planner else 120)
    while time.monotonic() < deadline:
        if result.exists():
            rows = json.loads(result.read_text())
            if any(row.get('action') == 'error' for row in rows):
                raise RuntimeError(rows)
            if any(row.get('done') for row in rows):
                a.output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(result, a.output)
                files = sources + [fixture / 'production.swift', fixture / 'planner.swift', fixture / 'production.ts', ROOT / 'src/projection/web.ts', ROOT / 'src/types.ts']
                metadata = {'device': a.device, 'container': str(container), 'sdk': run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version'), 'hashes': input_hashes}
                a.output.with_suffix('.metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
                print(json.dumps({'trials': len([row for row in rows if 'mode' in row]), 'container': str(container), 'output': str(a.output)}))
                break
        time.sleep(.25)
    else:
        raise TimeoutError(str(result))
