#!/bin/bash
# Compile the npm-distributed Pod without a renderer or a spec repository entry.
set -euo pipefail
ENGINE_PODS_TEMP=$(mktemp -d)
trap 'rm -rf "$ENGINE_PODS_TEMP"' EXIT
archive=$(npm pack . --ignore-scripts --json --pack-destination "$ENGINE_PODS_TEMP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].filename')
mkdir -p "$ENGINE_PODS_TEMP/engine" "$ENGINE_PODS_TEMP/app"
tar -xzf "$ENGINE_PODS_TEMP/$archive" --strip-components=1 -C "$ENGINE_PODS_TEMP/engine"
cat > "$ENGINE_PODS_TEMP/app/Podfile" <<'RUBY'
platform :ios, '15.0'
install! 'cocoapods', :integrate_targets => false
use_frameworks!
target 'App' do
  pod 'CapacitorNativeUIEngine', :path => '../engine'
end
RUBY
pod install --project-directory="$ENGINE_PODS_TEMP/app"
xcodebuild -project "$ENGINE_PODS_TEMP/app/Pods/Pods.xcodeproj" -scheme CapacitorNativeUIEngine -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
