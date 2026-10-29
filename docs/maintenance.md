# Development and releases

Use this guide when changing or publishing the Engine itself. A native consumer
may build without Node.js, so source changes must regenerate the bundled runtime.
A release may reach npm before Maven artifacts are downloadable, so publication
acceptance and consumer download readiness are checked separately below.

## Development

The public entry points are `src/index.ts` and `src/ionic.ts`, with shared contracts in `src/types.ts`. Implementation is grouped by responsibility:

- `src/native/`: bridge transport, native sessions, startup and resource URLs.
- `src/projection/`: image handoff, projection ownership, events and styles.
- `src/dom/`: geometry, scrolling, visibility and overlay coordination.

`npm run build` bundles `src/native/bootstrap.ts` into `runtime/native-ui-engine.js`, the shared WebView runtime. Android packages this file directly as an asset. The build also copies it into `ios/Sources/WebViewNativeUIEngine/Resources` because SwiftPM requires resources inside the target directory. Both generated files are ignored during development and included in release tags so SwiftPM consumers do not need Node.js. Run `npm run build` before building a source checkout with Xcode. Edit the TypeScript source, not either generated file; CI checks regeneration and verifies the runtime included in npm and Maven archives.

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

Lint combines strict TypeScript checking, the standard ESLint/TypeScript recommended rules, and typed Promise checks for `src`. Scripts and tests receive syntax-level linting; Prettier owns formatting. `npm run format` applies formatting only. Bridge payloads and test doubles may use explicit `any`; production boundary validation remains necessary. An explicit `void` marks background work, but does not handle a rejected Promise.

Native checks run in their platform CI jobs: `npm run lint:swift` uses node-swiftlint with the Capacitor configuration on macOS (`brew install swiftlint`); `npm run lint:android` runs Kotlin formatting checks and Android Lint with warnings treated as errors (JDK 21 and Android SDK 36). Use `npm run format:swift` and `npm run format:kotlin` to apply native formatting. Kotlin uses ktfmt because the Prettier Kotlin plugin cannot parse the existing native test fixture.

These checks include native tests and Cordova fixtures. Swift API documentation uses `///`; implementation notes use `//`. Swift size/complexity heuristics do not force state-machine splits or public API changes; fixture-only force unwraps/casts are permitted, while production retains the checks. Swift is also compiled and tested on an iOS simulator.

The engine is versioned independently of its consumers. Publish order is Maven publication acceptance → npm engine; consumers upgrade separately. npm releases require a successful Maven publication workflow for the exact tagged commit. Maven Central distribution may still be pending: Android consumers must wait until the matching POM and AAR are downloadable, while iOS and Web consumers can upgrade immediately. No publication is performed by build or test commands. Tests cover plain DOM, fractional/RTL geometry, stale ACKs, image ownership and native WKWebView scroll tracking; consumer tests remain responsible for Ionic/SDK integration.

CI-only setup, packaging commands and GitHub outputs are defined in `.github/workflows/`. Scripts retain the runtime build, reusable consumer/package verification, and tested publication logic (Central state handling and npm artifact comparison).

## Maven publication

The `Native UI Engine Maven Release` workflow is manually dispatched on the release tag with the exact engine package version. The tagged commit must first pass `Native UI Engine` CI. It signs an AAR, source archive, generated Kotlin API documentation and Maven metadata, uploads once, and completes when Central reports `PUBLISHING` or `PUBLISHED`. The deployment ID and state changes are recorded in the run summary. `PUBLISHING` means validation passed and Central accepted publication; it does not guarantee that artifacts can already be downloaded. This workflow does not wait for distribution. The npm release checks that this workflow succeeded for the exact release commit; it does not wait for Maven Central distribution. Existing coordinates are never overwritten; if an upload times out, inspect the recorded deployment in Central before taking further action.

Configure the repository's Actions secrets with `CENTRAL_USERNAME`, `CENTRAL_PASSWORD` (a Central user token), `MAVEN_SIGNING_KEY` (ASCII-armored private key) and `MAVEN_SIGNING_PASSWORD`. The signing public key must be available to Central. GitHub secrets are scoped to this repository.

For local packaging verification, run `python3 scripts/native-ui-engine-release/verify.py` with JDK 21, Android SDK 36 and GnuPG. It creates a disposable key, validates signatures and checksums, and deletes its test ZIP without uploading. Publication always rebuilds from clean outputs with the real signing key. Publish its Maven artifact before the corresponding npm release, including prereleases.

## Maintainer release setup

Publish the same version for npm, SwiftPM and Maven; consumers pin matching
versions across these distributions.

The npm organization `webview-native-ui` and Maven Central namespace `io.github.webview-native-ui` are registered. Maintain npm trusted publishing for `webview-native-ui/engine`, workflow `release.yml`, and provision the Maven secrets above in this repository. Credentials are not copied by moving source files.

1. Run **Prepare release** (`prepare-release.yml`) on `main` and select `major`, `minor`, `patch` or `revision`. No local build, commit or tag is needed.
2. The workflow increments the version using npm, builds and verifies the package, and pushes a version-only main commit plus a separate release commit/tag containing the generated resources. It explicitly starts `Native UI Engine` validation on that tag and creates a GitHub Release draft with generated release notes.
3. Review and edit the release notes. After tag validation passes, dispatch `native-ui-engine-release.yml` on that tag with the exact package version.
4. Once Maven publication succeeds, publish the GitHub Release draft. Central `PUBLISHING` means upload acceptance, not download readiness; mention any pending Android distribution in the notes. `release.yml` verifies the tag, package version, tag CI and Maven acceptance before publishing to npm (`next` for revisions, `latest` for stable releases).

Version increments follow npm SemVer rules; `revision` maps to `prerelease`:

| Current   | Selection | Next      |
| --------- | --------- | --------- |
| `1.2.3`   | major     | `2.0.0`   |
| `1.2.3`   | minor     | `1.3.0`   |
| `1.2.3`   | patch     | `1.2.4`   |
| `1.2.3`   | revision  | `1.2.4-0` |
| `1.2.4-0` | revision  | `1.2.4-1` |
| `1.2.4-2` | patch     | `1.2.4`   |
| `1.3.0-2` | minor     | `1.3.0`   |
| `2.0.0-2` | major     | `2.0.0`   |

Generated runtime commits never enter main's history. The CI preparation pushes main and the release tag atomically, without force. Publication accepts only a tagged child of main that adds the two generated resources and changes no other files. npm rebuilds and checks the runtime before publication; Maven packages the runtime from the same tested tag.

If preparation fails before pushing, rerun it. If main and the tag were already pushed, do not rerun preparation (that requests another version) or move the tag. Manually run `Native UI Engine` on the existing tag if validation was not started, and create the release draft for that tag if it is missing. This also recovers a failure between the push, validation dispatch and draft creation. Existing tags and published artifacts are never overwritten.

No build or test command publishes a package. Existing npm/Maven versions are never overwritten.

To rerun release verification for an existing tag, dispatch `release.yml` with that tag. It checks the original tagged commit and skips npm publication only when the existing package contents match. Keep the tag unchanged. Release tooling uses the Node.js 24 bundled npm, matching CI.

[Documentation overview](README.md)
