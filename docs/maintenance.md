# Development and releases

## Development

The public entry points are `src/index.ts` and `src/ionic.ts`, with shared contracts in `src/types.ts`. Implementation is grouped by responsibility:

- `src/native/`: bridge transport, native sessions, startup and resource URLs.
- `src/projection/`: image handoff, projection ownership, events and styles.
- `src/dom/`: geometry, scrolling, visibility and overlay coordination.

`npm run build` bundles `src/native/bootstrap.ts` into `runtime/native-ui-engine.js`, the shared WebView runtime. Android packages this file directly as an asset. The build also copies it into `ios/Sources/WebViewNativeUIEngine/Resources` because SwiftPM requires resources inside the target directory. Both generated files are committed so native consumers do not need Node.js. Edit the TypeScript source, not either generated file; CI checks regeneration and verifies the runtime included in npm and Maven archives.

Browser tests mirror these groups under `tests/`. `tests/cordova/` contains the real native consumer fixture.

Use Node.js 24, matching CI. From this repository:

```sh
npm ci
npm run build
npm run lint
npx playwright install chromium
npm test
xcodebuild -scheme WebViewNativeUIEngine -destination 'platform=iOS Simulator,id=<booted simulator UUID>' test
```

Lint combines strict TypeScript checking, the standard ESLint/TypeScript recommended rules, and typed Promise checks for `src`. Scripts and tests receive syntax-level linting; Prettier owns formatting. `npm run format` applies formatting only. Bridge payloads and test doubles may use explicit `any`; production boundary validation remains necessary. An explicit `void` marks background work, but does not handle a rejected Promise. Android uses `lintRelease` with warnings treated as errors in CI; Swift is compiled and tested on an iOS simulator.

The engine is versioned independently of its consumers. Publish order is Maven publication acceptance → npm engine; consumers upgrade separately. npm releases require a successful Maven publication workflow for the exact tagged commit. Maven Central distribution may still be pending: Android consumers must wait until the matching POM and AAR are downloadable, while iOS and Web consumers can upgrade immediately. No publication is performed by build or test commands. Tests cover plain DOM, fractional/RTL geometry, stale ACKs, image ownership and native WKWebView scroll tracking; consumer tests remain responsible for Ionic/SDK integration.

CI-only setup, packaging commands and GitHub outputs are defined in `.github/workflows/`. Scripts retain the runtime build, reusable consumer/package verification, and tested publication logic (Central state handling and npm artifact comparison).

## Maven publication

The `Native UI Engine Maven Release` workflow is manually dispatched on `main` with the exact engine package version. That commit must first pass `Native UI Engine` CI. It signs an AAR, source archive, generated Kotlin API documentation and Maven metadata, uploads once, and completes when Central reports `PUBLISHING` or `PUBLISHED`. The deployment ID and state changes are recorded in the run summary. `PUBLISHING` means validation passed and Central accepted publication; it does not guarantee that artifacts can already be downloaded. This workflow does not wait for distribution. The npm release checks that this workflow succeeded for the exact release commit; it does not wait for Maven Central distribution. Existing coordinates are never overwritten; if an upload times out, inspect the recorded deployment in Central before taking further action.

Configure the repository's Actions secrets with `CENTRAL_USERNAME`, `CENTRAL_PASSWORD` (a Central user token), `MAVEN_SIGNING_KEY` (ASCII-armored private key) and `MAVEN_SIGNING_PASSWORD`. The signing public key must be available to Central. GitHub secrets are scoped to this repository.

For local packaging verification, run `python3 scripts/native-ui-engine-release/verify.py` with JDK 21, Android SDK 36 and GnuPG. It creates a disposable key, validates signatures and checksums, and deletes its test ZIP without uploading. Publication always rebuilds from clean outputs with the real signing key. Publish its Maven artifact before the corresponding npm release, including prereleases.

## Maintainer release setup

This repository starts from the merged Engine implementation at [ionic-theme-ios27 `b218d8b`](https://github.com/rdlabo-dev/ionic-theme-ios27/commit/b218d8bfe0c87c02addc668fee9c7aa333489486). Extraction preserves the merged implementation; Cordova host support is developed in this repository. The renamed package starts at version `0.0.1`. Publish the same version for npm, SwiftPM and Maven; do not reuse the old package coordinates.

The npm organization `webview-native-ui` and Maven Central namespace `io.github.webview-native-ui` are registered. Maintain npm trusted publishing for `webview-native-ui/engine`, workflow `release.yml`, and provision the Maven secrets above in this repository. Credentials are not copied by moving source files.

1. Prepare the next version and release notes on `main`; use `npm run release` to create a standard `vX.Y.Z` tag/GitHub release. Keep the GitHub release as a draft until the Maven publication workflow succeeds.
2. After that main commit passes CI, dispatch `native-ui-engine-release.yml` with the exact package version.
3. Central `PUBLISHING` is an accepted upload, not download readiness. Once the Maven publication workflow succeeds, publish the prepared GitHub release. Note any pending Android artifact distribution in the release notes. `release.yml` verifies the tag, package version, CI and Maven publication acceptance before npm publication (`next` for prereleases, `latest` otherwise).

No build or test command publishes a package. Existing npm/Maven versions are never overwritten.

To rerun release verification for an existing tag, dispatch `release.yml` with that tag. It checks the original tagged commit and skips npm publication only when the existing package contents match. Keep the tag unchanged. Release tooling uses the Node.js 24 bundled npm, matching CI.
