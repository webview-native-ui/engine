#!/usr/bin/env python3
"""Run the actual WebProjection/native handler on a simulator and count avoided work."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
import plistlib
import platform

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
args = parser.parse_args()
def run(*cmd):
    return subprocess.check_output([str(x) for x in cmd], cwd=root, text=True).strip()

with tempfile.TemporaryDirectory(prefix='native-pipeline-') as folder:
    folder = Path(folder)
    app = folder / 'Pipeline.app'
    app.mkdir()
    run('node_modules/.bin/esbuild', 'tests/performance/ios/pipeline.ts', '--bundle', '--format=iife', '--outfile=' + str(app / 'pipeline.js'))
    capture = (root / 'ios/Sources/WebViewNativeUIEngine/CoveredSnapshots.swift').read_text()
    capture = capture.replace('        let bounds = regions.reduce', '        rasterCaptures += 1\n        let bounds = regions.reduce', 1)
    capture = capture.replace('                    try png.write', '                    pngWrites += 1\n                    try png.write', 1)
    capture = capture.replace('                    let image = UIImage(cgImage: decoded', '                    nativeDecodes += 1\n                    let image = UIImage(cgImage: decoded', 1)
    (folder / 'Capture.swift').write_text(capture)
    encoder = (root / 'ios/Sources/WebViewNativeUIEngine/NativeUIPngEncoder.swift').read_text()
    encoder = encoder.replace('        let bounds = image.extent', '        pngEncodes += 1\n        let bounds = image.extent', 1)
    (folder / 'Encoder.swift').write_text(encoder)
    library = root / 'native/artifacts/NativeUIPng.xcframework/ios-arm64_x86_64-simulator/libnative_ui_png.a'
    run('xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-O', '-parse-as-library', '-target', platform.machine() + '-apple-ios15.0-simulator', '-module-cache-path', folder / 'modules', '-I', root / 'native/include', root / 'tests/performance/ios/main.swift', folder / 'Capture.swift', folder / 'Encoder.swift', library, '-o', app / 'Pipeline')
    plist = {'CFBundleIdentifier': 'local.native.pipeline', 'CFBundleExecutable': 'Pipeline', 'CFBundleName': 'Pipeline', 'CFBundlePackageType': 'APPL', 'MinimumOSVersion': '15.0', 'UILaunchScreen': {}, 'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False, 'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{'UISceneConfigurationName': 'Default', 'UISceneDelegateClassName': 'Pipeline.Scene'}]}}}
    (app / 'Info.plist').write_bytes(plistlib.dumps(plist))
    run('xcrun', 'simctl', 'install', args.device, app)
    container = Path(run('xcrun', 'simctl', 'get_app_container', args.device, 'local.native.pipeline', 'data'))
    result = container / 'Documents/pipeline.json'
    result.unlink(missing_ok=True)
    run('xcrun', 'simctl', 'launch', args.device, 'local.native.pipeline')
    for _ in range(120):
        if result.exists():
            data = json.loads(result.read_text())
            output = root / 'docs/validation/image-pipeline-ios.json'
            output.write_text(json.dumps(data, indent=2) + '\n')
            assert data['action'] == 'done', data
            rows = {x['stage']: x for x in data['checkpoints']}
            cold = rows['cold']
            assert cold['captures'] == 1 and cold['files'] == 12, data
            for key in ('encodes', 'writes', 'nativeDecodes', 'fileReads', 'decodes'):
                assert cold[key] == 12, (key, data)
                assert rows['content-changed'][key] == 24, (key, data)
            for stage in ('same-content-three-prepares', 'entry-return'):
                for key in ('captures', 'encodes', 'writes', 'nativeDecodes', 'fileReads', 'decodes'):
                    assert rows[stage][key] == cold[key], (stage, key, data)
            assert rows['content-changed']['captures'] == 2, data
            assert rows['destroy-reset']['files'] == 0, data
            print(json.dumps(data, indent=2))
            break
        time.sleep(0.5)
    else:
        raise SystemExit('Image pipeline fixture did not finish')
