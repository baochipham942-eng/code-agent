# Managed Runtime Assets Roadmap

Date: 2026-05-22

## Goal

Reduce Agent Neo update/download size without replacing the Tauri updater. The signed app shell continues to use the existing `.app.tar.gz + .sig + latest.json` path; large runtime assets move only after a measured inventory, resolver fallback, hash verification, and rollback path exist.

## Current Evidence

- Runtime assets report: `docs/audits/2026-05-22-agent-neo-runtime-assets-inventory.md`
- Inventory command: `npm run release:resource-inventory -- --root "src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_"`
- Current `_up_` size after the fourth slimming gate: 29.2 MiB
- Previous `_up_` size after the third slimming gate: 39.0 MiB
- Previous `_up_` size after the second slimming gate: 55.3 MiB
- Previous `_up_` size after the first slimming gate: 72.0 MiB
- Previous `_up_` size before moving the first pilot runtime: 102.9 MiB
- Largest candidates:
  - `dist/native`: 1.87 MiB
  - `scripts/vision-tagger`: 115.7 KiB
  - `scripts/vision-ocr`: 94.8 KiB
  - `scripts/system-audio-capture`: 94.0 KiB

## Boundaries

- Do not change Tauri updater semantics in the first managed-runtime phase.
- Do not modify `.app`, `.dmg`, or `.app.tar.gz` after signing or notarization.
- Do not move `dist/web`, `dist/renderer`, `dist/native/better-sqlite3`, `keytar`, or `node-pty` in the first phase.
- Do not make runtime assets executable from an unverified path.
- Do not store audit JSON inside the client bundle.
- Do not rely on a user-installed system Node for packaged macOS startup.

## Stage 0: Inventory Gate

Status: implemented.

Deliverables:

- `scripts/tauri-resource-inventory.mjs`
- `npm run release:resource-inventory`
- `verify-macos-release.sh` runs the inventory after `release-security-scan`
- Markdown inventory report for the current bundle

Verification:

- `node --check scripts/tauri-resource-inventory.mjs`
- `npm run release:resource-inventory -- --root "src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_"`
- `bash scripts/verify-macos-release.sh`

## Stage 1: Runtime Resolver Contract

Purpose: introduce path resolution without moving assets yet.

Owner scope:

- Rust startup root discovery
- Node runtime resolver
- Existing fallback to bundled `_up_`

Expected files:

- `src-tauri/src/main.rs`
- `src/main/runtime/runtimeAssetResolver.ts` or equivalent
- targeted tests for resolver precedence

Contract:

- `resolveRuntimeRoot()`
- `resolveBundledPath("dist/web" | "dist/renderer" | "dist/native")`
- `resolveNodeModule(name)`
- `resolveHelperBinary(name)`

Verification:

- Current bundle still launches with bundled `_up_`.
- Resolver returns bundled paths when no managed runtime exists.
- No package size change is expected in this stage.

## Stage 2: Onnxruntime + VAD Managed Pilot

Status: implemented.

Purpose: move one high-value runtime set behind the resolver.

Pilot assets:

- `node_modules/onnxruntime-node`
- `node_modules/onnxruntime-common`
- `node_modules/avr-vad`

Expected changes:

- Desktop audio/VAD loaders use `resolveExistingNodeModule("onnxruntime-node")`.
- VAD model lookup uses `resolveExistingNodeModule("avr-vad")`.
- Default Tauri resources no longer include the pilot copies after Stage 6.
- Development `node_modules` still works as a fallback during local runs.
- Missing managed runtime disables VAD capture cleanly until local capability components are prepared.

Verification:

- VAD initializes from a staged managed runtime directory.
- VAD initializes from development `node_modules`.
- Missing managed runtime falls back cleanly.

## Stage 3: Runtime Package Builder

Status: implemented for `onnxruntime-vad`, `playwright-browser-runtime`, and `sharp-image-runtime`.

Purpose: produce signed/hash-addressed runtime packages without changing app install.

Expected files:

- `scripts/build-runtime-assets.mjs`
- `npm run release:runtime-assets`
- `runtime-assets/manifest.json` generated under `src-tauri/target/release/runtime-assets/`

Package rules:

- Archive per asset group and platform.
- Include sha256 for archive and expanded file tree.
- Include compatible app version range.
- Build from the checked-out dependency tree by default; a previous bundle can still be used through `--root`.
- Support release layout with `--flat-output`, `--manifest-name`, and `--archive-base-url`.
- Do not include first-party source, env, docs, or test artifacts.

Verification:

- Runtime package builds from current dependency tree.
- Hash mismatch is detectable.
- Packages are not added to Tauri resources.
- Existing release security scan runs against the staged package before archive creation.

## Stage 4: Managed Runtime Installer

Status: implemented for `onnxruntime-vad`, `playwright-browser-runtime`, and `sharp-image-runtime`.

Purpose: download/install runtime packages under Application Support with rollback.

Implemented behavior:

- Verify archive hash and expanded tree hash from `manifest.json`.
- Extract with zip-slip/path traversal protection and link-entry rejection.
- Atomically promote to `<userData>/runtime/<asset>/<hash>`.
- Write `<userData>/runtime/active.json` only after verified promotion.
- Keep one previous version.
- Fall back to bundled runtime if install fails.

Verification:

- `npx vitest run tests/unit/runtime/runtimeAssetInstaller.test.ts tests/unit/runtime/runtimeAssetResolver.test.ts tests/unit/runtime/runtimeAssetStatus.test.ts`
- `npm run release:runtime-assets:install -- --manifest src-tauri/target/release/runtime-assets/manifest.json --runtime-base-dir /tmp/agent-neo-runtime-install-smoke --json`
- Empty runtime directory installs pilot assets.
- Archive hash mismatch and expanded tree mismatch fail closed.
- Traversal and symlink entries are rejected before promotion.

## Stage 5: Product Surface

Status: implemented for status and manual prepare flow.

Purpose: show runtime update state without exposing package mechanics.

Implemented UI language:

- Core app update
- Local capability components
- Using bundled local capability components
- Local capability components unavailable

Implemented behavior:

- `/api/update?action=check` can include `runtimeAssets.manifestUrl` and `runtimeAssets.manifestSha256`.
- `UpdateService.checkForUpdates()` resolves runtime asset metadata and marks assets that are not installed.
- `UpdateService.prepareRuntimeAssets()` downloads the manifest and archive, verifies hashes, installs, and refreshes cached state.
- `UpdateSettings` shows the local component state and a separate prepare action when runtime assets need installation.

Verification:

- App update and runtime update are distinct.
- Runtime failure does not block app update checks or chat startup; moved capabilities report unavailable until local components are prepared.
- Forced app update still takes priority because Tauri update flow is unchanged.
- `npx vitest run tests/renderer/components/updateSettings.status.test.ts`
- Local remote smoke: an HTTP server served `/api/update`, `runtime-assets/manifest.json`, and the pilot `.tar.gz`; the client completed `checkForUpdates() -> prepareRuntimeAssets() -> getRuntimeAssetsStatus()` with `state=installed`.

## Stage 6: Bundle Slimming Gate

Status: implemented and verified with a rebuilt release bundle.

Purpose: remove the pilot runtime from the signed app shell after the managed install path is proven.

Implemented behavior:

- `src-tauri/tauri.conf.json` no longer bundles `node_modules/onnxruntime-node`.
- `src-tauri/tauri.conf.json` no longer bundles `node_modules/avr-vad`.
- `desktopAudioCapture` treats missing VAD runtime components as capability unavailable instead of a startup-breaking error.
- Release gate tests prevent the pilot modules from returning to default Tauri resources.

Verification:

- `npx vitest run tests/unit/runtime/runtimeAssetResolver.test.ts tests/unit/runtime/runtimeAssetStatus.test.ts tests/scripts/releaseMacosGates.test.ts`
- `npm run tauri:package`
- `npm run release:verify-macos`
- `npm run release:resource-inventory -- --root "src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_"`
- New `_up_` size is 72.0 MiB; `onnxruntime-node` and `avr-vad` are absent from the rebuilt bundle resources.

## Stage 7: Runtime Assets Release Publishing

Status: implemented for the GitHub Release and OSS publishing path.

Purpose: make managed runtime assets discoverable by real clients after a tagged release, not only by local smoke tests.

Implemented behavior:

- The release workflow builds runtime assets after the signed app/update manifest is ready.
- Runtime asset archives are uploaded to OSS under `v<version>/runtime-assets/`.
- The runtime manifest is generated with absolute archive URLs that point at OSS.
- The runtime manifest, sha256 sidecar, and archives are also attached to the GitHub Release.
- The update API can derive `runtimeAssets.manifestUrl` and `runtimeAssets.manifestSha256` from GitHub Release assets when env metadata is not configured.
- Env `RUNTIME_ASSETS_MANIFEST_URL(_CHANNEL)` and `RUNTIME_ASSETS_MANIFEST_SHA256(_CHANNEL)` still take precedence for emergency override or channel-specific rollout.

Verification:

- `npx vitest run tests/unit/vercel/updateMetadata.test.ts tests/scripts/releaseMacosGates.test.ts`
- `node --check scripts/build-runtime-assets.mjs`

## Stage 8: Playwright Browser Runtime Pilot

Status: implemented and verified with a rebuilt release bundle.

Purpose: move browser automation client runtime out of the signed app shell while preserving lazy loading and clear failure behavior.

Pilot assets:

- `node_modules/playwright`
- `node_modules/playwright-core`

Implemented behavior:

- Added a resolver-aware Playwright loader under `src/main/runtime/playwrightRuntime.ts`.
- `BrowserService` uses the shared loader for both system Chrome CDP and bundled Playwright paths.
- Dashboard interaction probes use the shared loader instead of direct `import('playwright')`.
- Runtime status registry now tracks both `onnxruntime-vad` and `playwright-browser-runtime`.
- `scripts/build-runtime-assets.mjs` builds both managed runtime assets by default.
- `src-tauri/tauri.conf.json` no longer bundles `node_modules/playwright` or `node_modules/playwright-core`.
- Release gate tests prevent Playwright from returning to default Tauri resources.

Verification:

- `npx vitest run tests/unit/runtime/playwrightRuntime.test.ts tests/unit/runtime/runtimeAssetStatus.test.ts tests/unit/runtime/runtimeAssetResolver.test.ts tests/scripts/releaseMacosGates.test.ts tests/unit/vercel/updateMetadata.test.ts`
- `npm run release:runtime-assets`
- `npm run release:runtime-assets:install -- --manifest src-tauri/target/release/runtime-assets/manifest.json --asset playwright-browser-runtime --runtime-base-dir /tmp/agent-neo-runtime-playwright-install --json`
- Direct `require()` from the installed Playwright runtime returns `chromium.launch` and `chromium.executablePath`.
- `npm run tauri:package`
- `npm run release:verify-macos`
- New `_up_` size is 55.3 MiB; Playwright, ONNX Runtime, and VAD modules are absent from rebuilt bundle resources.

## Stage 9: Sharp Image Runtime Pilot

Status: implemented and verified with a rebuilt release bundle.

Purpose: move native image processing out of the signed app shell while keeping screenshot privacy behavior explicit.

Pilot assets:

- `node_modules/sharp`
- `node_modules/@img/colour`
- `node_modules/@img/sharp-darwin-arm64`
- `node_modules/@img/sharp-libvips-darwin-arm64`
- `node_modules/detect-libc`

Implemented behavior:

- Added `src/main/runtime/sharpRuntime.ts` as the single resolver-aware Sharp loader.
- Vision image preparation falls back to original bytes if Sharp is missing or fails.
- Screenshot privacy redaction fails clearly when Sharp is unavailable, so a failed redaction is not reported as success.
- `image_process` and `image_annotate` load Sharp lazily through the shared runtime loader.
- Runtime status registry now tracks `sharp-image-runtime`.
- Runtime asset builder prunes `node_modules/.bin` and symlinks before archiving, preserving the installer's link-entry rejection.
- `src-tauri/tauri.conf.json` no longer bundles Sharp or its native darwin dependencies.
- Release gate tests prevent Sharp and its native dependencies from returning to default Tauri resources.

Verification:

- `npx vitest run tests/unit/runtime/sharpRuntime.test.ts tests/unit/runtime/runtimeAssetStatus.test.ts tests/scripts/releaseMacosGates.test.ts tests/unit/services/desktop/visionAnalysisService.test.ts tests/unit/services/desktop/visionAnalysisService.prepare.test.ts tests/unit/services/screenshotPrivacyRedactor.test.ts tests/unit/tools/modules/network/imageProcess.test.ts tests/unit/tools/modules/network/imageAnnotate.test.ts`
- `npm run typecheck`
- `npm run release:runtime-assets`
- `npm run release:runtime-assets:install -- --manifest src-tauri/target/release/runtime-assets/manifest.json --asset sharp-image-runtime --runtime-base-dir /tmp/agent-neo-runtime-sharp-install --json`
- Direct `require()` from the installed Sharp runtime returns a callable Sharp function and `sharp.kernel.lanczos3`.
- `tar -tvf src-tauri/target/release/runtime-assets/sharp-image-runtime/sharp-image-runtime-darwin-arm64-0.16.79.tar.gz` has no link entries.
- `npm run tauri:package`
- `npm run release:verify-macos`
- New `_up_` size is 39.0 MiB; Sharp, Playwright, ONNX Runtime, and VAD module directories are absent from rebuilt bundle resources.

## Stage 10: Better SQLite Runtime Pruning

Status: implemented and verified with a rebuilt release bundle.

Purpose: remove build-only SQLite source files from the signed app shell without changing the database runtime path.

Implemented behavior:

- `src-tauri/tauri.conf.json` now bundles only `node_modules/better-sqlite3/package.json`, `lib/**/*`, and `build/Release/better_sqlite3.node`.
- `node_modules/better-sqlite3/deps` and `node_modules/better-sqlite3/src` are no longer copied into `_up_`.
- `dist/native/better-sqlite3` stays in the app shell as the primary system-Node ABI runtime path.
- Release gate tests prevent the full `node_modules/better-sqlite3/**/*` glob and build-only inputs from returning.

Verification:

- `npx vitest run tests/scripts/releaseMacosGates.test.ts`
- `npm run tauri:package`
- `npm run release:resource-inventory -- --root "src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_"`
- `find "src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_" ...` confirms `better-sqlite3/deps`, `better-sqlite3/src`, Sharp, Playwright, ONNX Runtime, and VAD module directories are absent.
- Packaged web server smoke: running `_up_/dist/web/webServer.cjs` with `AGENT_NEO_RESOURCE_DIR` pointed at the app resources loads better-sqlite3 from `_up_/dist/native/better-sqlite3`, initializes the database, creates `code-agent.db`, and returns `{"status":"ok"}` from `/api/health`.
- New `_up_` size is 29.2 MiB.

## Stage 11: Bundled Node Runtime for Packaged macOS

Status: implemented locally; final size evidence comes from the release bundle built for this closeout.

Purpose: make packaged Agent Neo independent of whichever Node binary happens to exist on the user machine, and verify `better-sqlite3` against the Node ABI that actually starts `dist/web/webServer.cjs`.

Implemented behavior:

- `scripts/prepare-bundled-node.mjs` prepares `dist/bundled-node/bin/node` for macOS release builds.
- `tauri-prebuild-cleanup.sh` and `tauri-release-bundle.sh` run the prepare step before Tauri copies resources.
- `src-tauri/tauri.conf.json` includes `dist/bundled-node/**/*`.
- Tauri release startup resolves bundled Node before `NODE_BINARY` or system Node.
- `verify-macos-release.sh` checks that bundled Node is executable and can load `dist/native/better-sqlite3/build/Release/better_sqlite3.node`.
- `tauri-release-bundle.sh` re-signs the bundled Node binary with the rest of the nested Mach-O binaries before the app shell is re-signed.

Verification:

- `node --check scripts/prepare-bundled-node.mjs`
- `npm run tauri:release:bundle`
- `npm run release:verify-macos`
- Packaged app starts webServer through bundled Node and `/api/health` reports database-backed persistence.

## Current Closure

Stages 0-11 are implemented in code. The app still uses the existing signed Tauri update path for the core app shell, while heavy optional/local capability components are shipped as verified managed runtime assets. Stage 11 intentionally adds a small required runtime back into the signed shell because the startup Node ABI is core app infrastructure, not an optional local capability component.

Current size movement:

- Before managed runtime work: 102.9 MiB
- After ONNX/VAD: 72.0 MiB
- After Playwright: 55.3 MiB
- After Sharp: 39.0 MiB
- After better-sqlite3 runtime pruning: 29.2 MiB

Remaining candidates are small enough that they should not be moved without a specific release requirement:

- `dist/native`: 1.87 MiB, keep until database startup and fallback policy are redesigned.
- `scripts/vision-tagger`: 115.7 KiB, signed helper; moving requires helper signing and quarantine behavior review.
- `scripts/vision-ocr`: 94.8 KiB, signed helper; same boundary as above.
- `scripts/system-audio-capture`: 94.0 KiB, signed helper tied to audio capture startup and permissions.
