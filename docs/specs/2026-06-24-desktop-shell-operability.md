# 2026-06-24 Desktop Shell Operability Spec

> Status: as-built on current repository state
> Time window: 2026-06-24 CST
> Related architecture: [desktop-shell.md](../architecture/desktop-shell.md), [native-app-integration.md](../architecture/native-app-integration.md), [hot-update.md](../architecture/hot-update.md), [observability.md](../architecture/observability.md)

This batch keeps the current Tauri shell and renderer architecture. The change is operational: the desktop shell now has one diagnostics contract, one resource preflight vocabulary, one renderer serve decision, and one packaged smoke path that can be used before release or during production incident triage.

## Product Contract

| Area | Contract |
|------|----------|
| Shell diagnostics object | `DesktopShellDiagnostics` is the shared contract for app version, mode, channel, boot stage, webServer health, renderer source, resource checks, runtime assets, native permissions, renderer bundle status, repair actions, and issues. |
| Diagnostics IPC | The settings UI and packaged smoke use `diagnostics.desktopShell`. No new IPC domain is introduced. The response must not include raw env, raw boot token, user tokens, or secrets. |
| Boot explainability | Tauri records boot progress through `channel-env-applied`, `resource-preflight`, `server-script-resolved`, `node-binary-resolved`, `web-server-spawned`, `health-ready`, `window-navigated`, or `failed`. The latest record is written to `desktop-shell-boot-latest.json`; write failure must not stop boot. |
| Web health token check | `/api/health` remains the webServer readiness endpoint. Tauri compares the health boot token with the current shell token and records match or mismatch as a status, never the token value. |
| Release resource preflight | Packaged startup checks `dist/web/webServer.cjs`, `dist/renderer/index.html`, bundled Node, and `dist/native/better-sqlite3/build/Release/better_sqlite3.node`. Missing required resources are errors; optional resources such as control-plane public keys are warnings. |
| Renderer serve decision | `/api/health.rendererServe` and `DesktopShellDiagnostics.renderer` expose the same decision: `active`, `builtin`, or `static`, with reasons such as `active-healthy`, `hot-update-disabled`, `no-active-meta`, `invalid-active-meta`, `active-index-missing`, `active-older-than-shell`, or `static-override`. |
| Runtime asset registry | Runtime assets are registered with id, kind, delivery, platform, version, minimum shell version, and optional pinned hashes. Bundled assets must be visible in diagnostics; optional assets can warn without failing app startup. |
| Native permission contract | macOS permissions report `unknown`, `denied`, `granted`, `needs_restart`, `wrong_bundle_id`, or `unsupported` for microphone, screen recording, accessibility, notifications, and automation. The summary is attached to desktop diagnostics when available. |
| Native command boundary | Renderer code should call `nativeDesktop`, `nativeCommandFacade`, or `tauriPluginFacade` instead of scattering Tauri command names and plugin imports through feature components. |
| Crash recovery | Diagnostics surface previous incomplete boot records and derive repair actions such as clearing the webServer port, disabling hot renderer, rebuilding renderer cache, rebuilding desktop bundle resources, or inspecting boot diagnostics. |
| Dev/prod channel isolation | Diagnostics compare channel, data directory, web port, bundle id, and permission bundle id so dev packages do not silently reuse production state or permissions. |
| Release and local package gates | `verify:webserver-boot` is part of GitHub release workflow and local package scripts. `desktop-shell:packaged-smoke` produces a JSON artifact that can be passed to `release:post-publish` with `--require-desktop-shell-diagnostics`. |

## Architecture Map

| Layer | Files / Modules | Notes |
|------|------------------|-------|
| Shared shell contract | `src/shared/contract/desktopShell.ts`, `src/shared/contract/nativeDesktop.ts`, `src/shared/contract/update.ts` | Defines diagnostics, boot stages, resources, renderer serve decision, permission states, and runtime asset status. |
| Tauri boot diagnostics | `src-tauri/src/main.rs` | Records shell boot stages, resolves bundled Node and webServer script, runs preflight, spawns webServer, healthchecks, navigates the window, and records failures. |
| Native desktop permissions | `src-tauri/src/native_desktop.rs`, `src/renderer/services/nativeDesktop.ts` | Probes macOS permission state and gives the renderer a typed native desktop facade. |
| Diagnostics aggregation | `src/main/diagnostics/desktopShellDiagnostics.ts`, `src/main/ipc/diagnostics.ipc.ts` | Reads boot JSON, web health, renderer bundle status, runtime assets, permissions, channel isolation, and issue list into one IPC payload. |
| Renderer serve decision | `src/main/services/renderer/rendererBundleCache.ts`, `src/web/routes/static.ts`, `src/web/routes/health.ts` | Decides active vs builtin renderer and exposes the decision through `/api/health`. |
| Runtime assets | `src/main/runtime/runtimeAssetRegistry.ts`, `src/main/runtime/runtimeAssetStatus.ts`, `src/main/runtime/runtimeAssetInstaller.ts` | Registers bundled and optional native resources, node modules, helper binaries, app bundles, and tool binaries. |
| Renderer diagnostics UI | `src/renderer/components/features/settings/tabs/UpdateSettings.tsx` | Developer mode shows desktop shell summary, boot stage, webServer pid/port, renderer source, resource issues, runtime assets, and diagnostics file path. |
| Native command facades | `src/renderer/services/nativeCommandFacade.ts`, `src/renderer/services/tauriPluginFacade.ts` | Centralizes Tauri command and plugin boundaries used by Appshots, PiP, keyboard shortcuts, opener, dialog, and event listeners. |
| Release gates | `package.json`, `.github/workflows/release.yml`, `scripts/release-neo.sh`, `scripts/release-post-publish-verify.mjs` | Keeps `verify:webserver-boot` in release and package paths; post-publish verification can require packaged shell diagnostics. |
| Smoke and triage scripts | `scripts/desktop-shell-packaged-smoke.mjs`, `scripts/desktop-shell-diagnostics.mjs` | Launches a packaged `.app`, cross-checks boot JSON, `/api/health`, and `diagnostics.desktopShell`, then classifies failures without exposing secrets. |

## Verification Evidence

| Scope | Evidence |
|------|----------|
| Rust shell boot and permissions | `cargo test --manifest-path src-tauri/Cargo.toml` passed with 31 tests. |
| TypeScript type surface | `npm run typecheck` passed. |
| Web bundle boot gate | `npm run build:web && npm run verify:webserver-boot` passed through `release:neo -- --version 0.20.0`. |
| Local package | `npm run tauri:package` built `src-tauri/target/release/bundle/macos/Agent Neo.app`. The local package was Developer ID signed but not notarized because Apple notarization env was not loaded. |
| Packaged shell smoke | `npm run desktop-shell:packaged-smoke -- --app "src-tauri/target/release/bundle/macos/Agent Neo.app" --out /tmp/agent-neo-desktop-shell-smoke-0.20.0.json --json` returned `ok: true`, boot stage `window-navigated`, web health `ok`, boot token match `true`, required resources missing `0`, renderer `builtin / no-active-meta`, and only optional runtime asset warnings. |
| Release readiness script | `npm run release:neo -- --version 0.20.0` passed read-only release gates and did not push tags. |
| Post-publish verification | `npm run release:post-publish -- --version 0.20.0 --desktop-shell-diagnostics-file /tmp/agent-neo-desktop-shell-smoke-0.20.0.json --require-desktop-shell-diagnostics --json` consumed desktop shell diagnostics successfully, but production verification still failed on renderer rollout version mismatch. |
| Targeted TS coverage | `tests/services/rendererBundleCache.test.ts`, `tests/unit/diagnostics/desktopShellDiagnostics.test.ts`, `tests/unit/ipc/diagnostics.desktopShell.test.ts`, `tests/renderer/components/updateSettings.status.test.ts`, `tests/scripts/desktopShellDiagnostics.test.ts`, `tests/scripts/releasePostPublishVerify.test.ts`, and runtime asset tests cover the new contract surface. |

## Current Acceptance State

| Gate | State | Notes |
|------|-------|-------|
| P0 shell diagnostics | Accepted locally | Boot diagnostics, resource preflight, health token status, renderer decision, IPC aggregation, settings card, and release gate wiring are present. |
| P1 operability hardening | Accepted locally | Permission state machine, runtime asset registry/status, native command facade, crash repair actions, and dev/prod channel isolation are present. |
| Local packaged smoke | Accepted locally | Packaged `.app` boots and reports healthy shell diagnostics. |
| Production post-publish | Blocked outside the package | App update metadata, OSS renderer manifest, and release record report `0.20.0`, but control-plane renderer rollout is still `0.17.2`. |
| Full repository test suite | Not a blocker for this shell batch | `npm run test` still has existing wide-gate failures in design-system bare-button baseline and architecture debt allowlist. These are outside the desktop shell change set. |

## Boundaries

- This does not replace Tauri, move UI to pure Rust, rewrite updater semantics, or change the formal release route.
- Startup preflight is intentionally lightweight: existence and executability only, no full hash scan of every resource on each launch.
- Optional runtime assets can produce warnings. Required release resources and bundled runtime assets should fail package smoke or diagnostics classification.
- Diagnostics can include paths, versions, states, PIDs, short error messages, and recommended actions. They must not include raw environment variables, raw boot tokens, provider tokens, API keys, cookies, or secrets.
- Formal release still goes through tag-triggered GitHub Actions. Local `tauri:package` and `tauri:release:bundle` are package/debug validation paths.
