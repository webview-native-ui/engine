#!/usr/bin/env python3
"""Build checked-in PNG artifacts. Consumers need neither Cargo nor an NDK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CRATE = ROOT / 'native/png/Cargo.toml'
ARTIFACTS = ROOT / 'native/artifacts'
CARGO = os.environ.get('CARGO', 'cargo')
ANDROID = {
    'arm64-v8a': ('aarch64-linux-android', 'aarch64-linux-android23'),
    'armeabi-v7a': ('armv7-linux-androideabi', 'armv7a-linux-androideabi23'),
    'x86': ('i686-linux-android', 'i686-linux-android23'),
    'x86_64': ('x86_64-linux-android', 'x86_64-linux-android23'),
}

def run(*args):
    subprocess.run([str(a) for a in args], cwd=ROOT, check=True)

def library(target):
    run(CARGO, 'build', '--locked', '--release', '--manifest-path', CRATE, '--target', target)
    return ROOT / 'native/png/target' / target / 'release/libnative_ui_png.a'

def licenses():
    meta = json.loads(subprocess.check_output([CARGO, 'metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', str(CRATE)], cwd=ROOT))
    dest = ROOT / 'native/licenses'
    dest.mkdir(parents=True, exist_ok=True)
    records = []
    for package in meta['packages']:
        if package['name'] == 'native-ui-png':
            continue
        folder = Path(package['manifest_path']).parent
        found = []
        for file in folder.iterdir():
            if file.is_file() and file.name.upper().startswith(('LICENSE', 'COPYING', 'UNLICENSE')):
                name = f"{package['name']}-{package['version']}-{file.name}"
                shutil.copyfile(file, dest / name)
                found.append(name)
        if not found:
            raise RuntimeError(f"Missing dependency license: {package['name']}")
        records.append({'crate': package['name'], 'version': package['version'], 'license': package['license'], 'files': found})
    (dest / 'dependencies.json').write_text(json.dumps(records, indent=2) + '\n')
    sysroot = Path(subprocess.check_output([os.environ.get('RUSTC', 'rustc'), '--print', 'sysroot'], text=True).strip())
    shutil.copyfile(sysroot / 'share/doc/rust/COPYRIGHT-library.html', dest / 'Rust-standard-library.html')
    for name in ('MIT.txt', 'Apache-2.0.txt', 'Unicode-3.0.txt', 'LLVM-exception.txt'):
        shutil.copyfile(sysroot / 'share/doc/rust/licenses' / name, dest / ('Rust-' + name))
    if args.ndk:
        for name in ('NOTICE', 'NOTICE.toolchain'):
            shutil.copyfile(Path(args.ndk) / name, dest / ('Android-NDK-' + name))
    resources = ROOT / 'ios/Sources/WebViewNativeUIEngine/Resources/NativeUIPngLicenses'
    resources.mkdir(exist_ok=True)
    for file in dest.iterdir():
        if file.is_file() and not file.name.startswith('Android-NDK-'):
            shutil.copyfile(file, resources / file.name)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--platform', choices=['ios', 'android', 'all'], default='all')
parser.add_argument('--ndk', default=os.environ.get('ANDROID_NDK_HOME'))
args = parser.parse_args()
ARTIFACTS.mkdir(parents=True, exist_ok=True)
if args.platform in ('ios', 'all'):
    device = library('aarch64-apple-ios')
    arm = library('aarch64-apple-ios-sim')
    intel = library('x86_64-apple-ios')
    with tempfile.TemporaryDirectory(prefix='native-png-') as directory:
        stripped = []
        for name, source in [('device', device), ('arm', arm), ('intel', intel)]:
            path = Path(directory) / name / 'libnative_ui_png.a'
            path.parent.mkdir()
            shutil.copyfile(source, path)
            run('xcrun', 'strip', '-S', path)
            stripped.append(path)
        fat = Path(directory) / 'libnative_ui_png.a'
        run('xcrun', 'lipo', '-create', stripped[1], stripped[2], '-output', fat)
        output = ARTIFACTS / 'NativeUIPng.xcframework'
        if output.exists():
            shutil.rmtree(output)
        run('xcodebuild', '-create-xcframework', '-library', stripped[0], '-headers', ROOT / 'native/include', '-library', fat, '-headers', ROOT / 'native/include', '-output', output)
if args.platform in ('android', 'all'):
    if not args.ndk:
        parser.error('--ndk or ANDROID_NDK_HOME is required for Android')
    host = 'darwin-x86_64' if os.uname().sysname == 'Darwin' else 'linux-x86_64'
    toolchain = Path(args.ndk) / 'toolchains/llvm/prebuilt' / host / 'bin'
    for abi, (target, compiler) in ANDROID.items():
        static = library(target)
        output = ARTIFACTS / 'android' / abi / 'libnative_ui_png.so'
        output.parent.mkdir(parents=True, exist_ok=True)
        run(toolchain / f'{compiler}-clang', '-shared', '-O3', '-Wl,--no-undefined', '-Wl,--gc-sections', '-Wl,-z,max-page-size=16384', '-I', ROOT / 'native/include', ROOT / 'native/android/png-jni.c', static, '-ldl', '-lm', '-lunwind', '-o', output)
        run(toolchain / 'llvm-strip', '--strip-unneeded', output)
licenses()
sources = ['native/png/src/lib.rs', 'native/png/Cargo.toml', 'native/png/Cargo.lock', 'native/include/NativeUIPng.h', 'native/include/module.modulemap', 'native/android/png-jni.c', 'scripts/build-native-png.py']
manifest = {'rustc': subprocess.check_output([os.environ.get('RUSTC', 'rustc'), '--version'], text=True).strip(),
            'sources': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources},
            'licenses': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                         for base in (ROOT / 'native/licenses', ROOT / 'ios/Sources/WebViewNativeUIEngine/Resources/NativeUIPngLicenses')
                         for p in sorted(base.iterdir()) if p.is_file()},
            'artifacts': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(ARTIFACTS.rglob('*')) if p.is_file() and p.suffix in ('.a', '.so', '.h', '.modulemap', '.plist')}}
(ARTIFACTS / f'{args.platform}-build.json').write_text(json.dumps(manifest, indent=2) + '\n')
