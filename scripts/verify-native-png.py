#!/usr/bin/env python3
"""Reject stale source/binary combinations before packaging or release."""
import hashlib
import json
from pathlib import Path
import plistlib
import struct

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'native/artifacts/all-build.json').read_text())
for group in ('sources', 'artifacts', 'licenses'):
    for path, expected in manifest[group].items():
        actual = hashlib.sha256((root / path).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f'Stale native PNG {group}: {path}; run npm run build:native')
# Shared Rust notices have one tracked source; Android-only notices are separate.
shared = root / 'ios/Sources/WebViewNativeUIEngine/Resources/NativeUIPngLicenses'
android = root / 'native/licenses'
assert not ({p.name for p in shared.iterdir()} & {p.name for p in android.iterdir()}), 'Duplicate native notices'
assert all(p.name.startswith('Android-NDK-') for p in android.iterdir()), 'Non-Android notice outside canonical resources'
for abi, machine in {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86': 3, 'x86_64': 62}.items():
    path = f'native/artifacts/android/{abi}/libnative_ui_png.so'
    assert path in manifest['artifacts'], path
    binary = (root / path).read_bytes()
    assert binary.startswith(b'\x7fELF') and binary[5] == 1, path
    assert struct.unpack_from('<H', binary, 18)[0] == machine, path
    wide = binary[4] == 2
    assert binary[4] == (2 if abi in ('arm64-v8a', 'x86_64') else 1), path
    offset = struct.unpack_from('<Q' if wide else '<I', binary, 32 if wide else 28)[0]
    size, count = struct.unpack_from('<HH', binary, 54 if wide else 42)
    loads = 0
    for index in range(count):
        header = offset + index * size
        if struct.unpack_from('<I', binary, header)[0] == 1:
            loads += 1
            alignment = struct.unpack_from('<Q' if wide else '<I', binary, header + (48 if wide else 28))[0]
            assert alignment >= 16384, (path, alignment)
    assert loads > 0, path
info = plistlib.loads((root / 'native/artifacts/NativeUIPng.xcframework/Info.plist').read_bytes())
variants = {x.get('SupportedPlatformVariant', 'device'): x for x in info['AvailableLibraries']}
assert variants['device']['SupportedPlatform'] == 'ios'
assert set(variants['device']['SupportedArchitectures']) == {'arm64'}
assert set(variants['simulator']['SupportedArchitectures']) == {'arm64', 'x86_64'}
print('Native PNG: source hashes, binary hashes, iOS slices, four Android ABIs and 16 KiB ELF alignment verified')
