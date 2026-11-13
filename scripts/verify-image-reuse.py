#!/usr/bin/env python3
"""Verify image reuse, content invalidation and cleanup on an iOS simulator."""
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

def replace_once(source, before, after):
    assert source.count(before) == 1, f'Instrumentation anchor changed: {before}'
    return source.replace(before, after, 1)

with tempfile.TemporaryDirectory(prefix='native-pipeline-') as folder:
    folder = Path(folder)
    app = folder / 'Pipeline.app'
    app.mkdir()
    run('node_modules/.bin/esbuild', 'tests/integration/image-reuse/pipeline.ts', '--bundle', '--format=iife', '--outfile=' + str(app / 'pipeline.js'))
    capture = (root / 'ios/Sources/WebViewNativeUIEngine/CoveredSnapshots.swift').read_text()
    capture = replace_once(capture, '        let groups = NativeUICapturePlanner.plan', '        rasterCaptures += 1\n        let groups = NativeUICapturePlanner.plan')
    capture = replace_once(capture, 'try png.write(to: file, options: .atomic)', 'pipelineCounterLock.lock(); pngWrites += 1; pipelineCounterLock.unlock()\n                                try png.write(to: file, options: .atomic)')
    capture = replace_once(capture, 'let image = UIImage(cgImage: decoded', 'pipelineCounterLock.lock(); nativeDecodes += 1; pipelineCounterLock.unlock()\n                                let image = UIImage(cgImage: decoded')
    capture = replace_once(capture, '        let comparePixels = job != nil', '        pipelineStage("acquired")\n        let comparePixels = job != nil')
    capture = replace_once(capture, '            let rawPixels = comparePixels', '            pipelineStage("processing")\n            let rawPixels = comparePixels')
    (folder / 'Capture.swift').write_text(capture)
    encoder = (root / 'ios/Sources/WebViewNativeUIEngine/NativeUIPngEncoder.swift').read_text()
    encoder = replace_once(encoder, '        let bounds = image.extent', '        pipelineCounterLock.lock(); pngEncodes += 1; pipelineCounterLock.unlock()\n        let bounds = image.extent')
    (folder / 'Encoder.swift').write_text(encoder)
    library = root / 'native/artifacts/NativeUIPng.xcframework/ios-arm64_x86_64-simulator/libnative_ui_png.a'
    target = platform.machine() + '-apple-ios15.0-simulator'
    sdk = run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path')
    glass = root / 'ios/Sources/NativeUIGlassCapture'
    # This fixture compiles Swift sources directly, outside SwiftPM/CocoaPods.
    # Compile the real Objective-C++ boundary and expose its header to Swift too.
    run('xcrun', '--sdk', 'iphonesimulator', 'clang++', '-target', target, '-isysroot', sdk,
        '-fobjc-arc', '-I', glass / 'include', '-c', glass / 'NativeUIGlassCapture.mm', '-o', folder / 'GlassCapture.o')
    run('xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-O', '-parse-as-library', '-target', target,
        '-module-cache-path', folder / 'modules', '-I', root / 'native/include',
        '-import-objc-header', glass / 'include/NativeUIGlassCapture.h',
        root / 'tests/integration/image-reuse/main.swift', folder / 'Capture.swift', folder / 'Encoder.swift',
        root / 'ios/Sources/WebViewNativeUIEngine/CapturePlanner.swift',
        root / 'ios/Sources/WebViewNativeUIEngine/SnapshotEventInterception.swift',
        folder / 'GlassCapture.o', library, '-lc++', '-o', app / 'Pipeline')
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
            assert data['action'] == 'done', data
            rows = {x['stage']: x for x in data['checkpoints']}
            cold = rows['empty-cache']
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
