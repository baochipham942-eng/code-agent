# Desktop Shell Operability Architecture

> Scope: Tauri shell, bundled Node webServer, renderer bundle selection, native runtime assets, and release diagnostics.
> Release contract: [Agent Neo Release Checklist](../releases/RELEASE_CHECKLIST.md)

Agent Neo keeps a split desktop runtime: the Tauri Rust process owns the native shell, permissions, bundled resources, and updater boundary; the spawned Node webServer owns application services and serves the React renderer. This architecture page documents how the shell explains startup and how release/debug tooling proves the package is usable.

## Startup Path

```
Tauri Rust shell
  -> apply channel env
  -> preflight packaged resources
  -> resolve dist/web/webServer.cjs
  -> resolve bundled Node
  -> spawn webServer child process
  -> initialize local config and persistence
  -> start remote plugins / skills / MCP capability bootstrap in background
  -> healthcheck /api/health with boot token match
  -> navigate main window to webServer
  -> finish remote capabilities and durable recovery behind a fail-closed readiness flag
  -> expose diagnostics through diagnostics.desktopShell
```

`dist/web/webServer.cjs` is a ~1.2KB launcher, not the application bundle: it enables the Node V8 compile cache (`<data dir>/cache/v8-compile-cache`) and then requires `dist/web/webServer.bundle.cjs` (the real ~20MB payload). Both files ship as Tauri resources; the shell's spawn path and boot stages are unchanged. Compile-cache failures degrade silently — the payload still loads without cache.

The Rust shell writes `desktop-shell-boot-latest.json` under the app log directory. The write is best-effort. If the file cannot be written, the app continues booting and the diagnostics IPC falls back to live checks where possible.

`/api/health` is shell readiness, not proof that every remote capability is connected. Fresh-profile startup must not wait for Cloud config, remote skill repositories, or MCP handshakes before the HTTP listener and first window navigation. Those capabilities initialize in the background; connection failures are warnings and leave the affected capability unavailable without taking down the builtin renderer. Durable recovery waits for capability bootstrap and remains fail-closed until its handlers are ready.

Boot stages are intentionally coarse and stable:

| Stage | Meaning |
|------|---------|
| `channel-env-applied` | Dev/prod channel values were applied before resource lookup. |
| `resource-preflight` | Required release resources were checked for presence and executability. |
| `server-script-resolved` | `dist/web/webServer.cjs` was found. |
| `node-binary-resolved` | Bundled Node was found and executable. |
| `web-server-spawned` | Node child process was started. |
| `health-ready` | `/api/health` responded and matched the expected boot token. |
| `window-navigated` | The Tauri window navigated to the running webServer. |
| `failed` | Boot stopped; `failedStage` and issue codes explain the last known boundary. |

## Diagnostics Model

`DesktopShellDiagnostics` is the single reader contract. It is defined in `src/shared/contract/desktopShell.ts` and returned by `diagnostics.desktopShell`.

| Section | Source | Purpose |
|---------|--------|---------|
| `app` | main process env and platform app adapter | Version, mode, bundle id, data directory, web port, pid, and channel. |
| `boot` | `desktop-shell-boot-latest.json` | Last boot stage, webServer pid, server root, script path, Node path, boot token match state, and previous failure summary. |
| `webServer` | `GET /api/health` | Live health, pid, server root, persistence health, and transport errors. |
| `renderer` | `/api/health.rendererServe` or fallback decision | Active/builtin/static renderer source, reason, serve directory, shell version, active bundle metadata, and hot-update disable reason. |
| `resources` | Tauri preflight or main-process fallback | Required and optional package resource status. |
| `runtimeAssets` | `runtimeAssetStatus` | Bundled/optional runtime asset availability, version, platform, minimum shell version, and hash summary. |
| `nativePermissions` | native desktop bridge | macOS permission states when Tauri runtime is available. |
| `rendererBundle` | renderer bundle cache | Active bundle metadata and cache status. |
| `channelIsolation` | diagnostics aggregator | Dev/prod data directory, port, bundle id, and permission bundle id checks. |
| `repairActions` | diagnostics aggregator | Suggested low-risk recovery actions derived from the current issue set. |
| `issues` | boot, resource, web, and previous failure records | Reader-facing issue codes, severity, short message, and optional action. |

Diagnostics can expose state and paths. They must not expose raw env, raw boot token, user tokens, provider secrets, cookies, or signing material. The packaged smoke script and post-publish verifier both assert this boundary.

## Resource Preflight

Startup preflight is deliberately small. It checks only resources that determine whether the packaged shell can start and load a renderer:

| Resource id | Path | Required | Failure effect |
|-------------|------|----------|----------------|
| `web-server-script` | `dist/web/webServer.cjs` | Yes | Boot cannot spawn application server. |
| `renderer-index` | `dist/renderer/index.html` | Yes | Builtin renderer fallback cannot load. |
| `bundled-node` | `dist/bundled-node/bin/node`, `dist/bundled-node/node`, or platform equivalent | Yes | Boot cannot run the bundled webServer. |
| `better-sqlite3-native` | `dist/native/better-sqlite3/build/Release/better_sqlite3.node` | Yes | Packaged persistence is likely broken. |
| `control-plane-public-keys` | `dist/web/control-plane-public-keys.json` | No | Control-plane verification can warn, but shell startup continues. |

Runtime assets are tracked separately through `RUNTIME_ASSET_DEFINITIONS`. Bundled assets include `sharp-image-runtime`, `system-audio-capture`, `vision-ocr`, `vision-tagger`, `computer-use-app`, `uv`, and `rtk`. Optional assets include `onnxruntime-vad` and `playwright-browser-runtime`.

Missing `onnxruntime-vad` or `playwright-browser-runtime` remains a warning and first-use delivery concern. Neither asset is allowed to become a required shell-start resource.

## Renderer Serve Decision

The webServer owns the renderer serve decision because it serves either the active hot-update bundle or the builtin renderer from the package. The decision is exposed both in `/api/health` and in desktop shell diagnostics.

| Reason | Source | Meaning |
|--------|--------|---------|
| `active-healthy` | `active` | Active renderer metadata is valid, version is compatible with the shell, and `index.html` exists. |
| `hot-update-disabled` | `builtin` | Renderer hot update was disabled by env or runtime policy. |
| `no-active-meta` | `builtin` | No active bundle metadata exists in the renderer cache. |
| `invalid-active-meta` | `builtin` | Active bundle metadata cannot be parsed or does not match the contract. |
| `active-index-missing` | `builtin` | Active metadata exists, but the active renderer `index.html` is missing. |
| `active-older-than-shell` | `builtin` | Active renderer version is lower than the current shell version. |
| `static-override` | `static` | Static directory override is active for a development or diagnostic run. |

The release invariant is simple: a packaged app must always have a builtin renderer that can load, and an active renderer may only replace it when metadata and resource checks pass.

## Native Boundary

Renderer components should use facades for native calls:

| Facade | Purpose |
|--------|---------|
| `src/renderer/services/nativeDesktop.ts` | Typed access to native desktop capabilities, permissions, frontmost context, desktop activity collector, and computer surface state. |
| `src/renderer/services/nativeCommandFacade.ts` | Typed access to direct Tauri commands used by Appshots, PiP, image reads, and global hotkeys. |
| `src/renderer/services/tauriPluginFacade.ts` | Lazy wrappers for Tauri event, opener, and dialog plugins. |

This keeps UI code independent from raw Tauri command names and plugin import details. The known dedicated wrappers for updater and notification behavior can stay separate because they already model a specific product surface.

## Channel Isolation

Diagnostics classify shell channel as `prod` or `dev` and compare four boundaries:

| Check | Production expectation | Dev expectation |
|-------|------------------------|-----------------|
| Data directory | Not `.code-agent-dev` | `.code-agent-dev` for packaged dev builds |
| Web port | `8180` | `8181` for packaged dev builds |
| Bundle id | `com.linchen.code-agent` | `com.linchen.code-agent.dev` or local development runtime |
| Permission bundle id | Matches current bundle id | Matches current bundle id |

Warnings here do not stop boot. They are meant to prevent a package from silently reading the wrong data directory or causing macOS permission confusion.

## Crash Recovery

The shell keeps the previous boot record and derives repair actions from the current failure boundary:

| Action | Trigger |
|--------|---------|
| Inspect boot diagnostics | Previous failure, current boot failure, or unreachable webServer. |
| Clear webServer port | Unreachable health, boot token mismatch, healthcheck failure, or boot stuck after spawn. |
| Disable hot renderer | Active renderer is in use or active cache looks incompatible. |
| Rebuild renderer cache | Active renderer directory or metadata is stale or missing. |
| Rebuild desktop bundle resources | Required release resources are missing or not executable. |

These are repair hints, not automatic destructive cleanup. The settings UI shows them in developer mode and the packaged smoke script turns them into failure/warning evidence for release work.

## Release Gates

The release path has three relevant checks:

| Gate | Command / location | Purpose |
|------|--------------------|---------|
| Source webServer boot gate | `npm run build:web && npm run verify:webserver-boot` | Proves the built Node webServer can start before packaging. |
| Local package gate | `npm run tauri:package` or `npm run tauri:release:bundle` | Includes `verify:webserver-boot` before Tauri build and package security scan. |
| Packaged shell smoke | `npm run desktop-shell:packaged-smoke -- --app ".../Agent Neo.app" --json` | Launches the packaged app, reads boot JSON, checks `/api/health`, calls `diagnostics.desktopShell`, and verifies the three views agree. |
| Post-publish gate | `npm run release:post-publish -- --desktop-shell-diagnostics-file <file> --require-desktop-shell-diagnostics` | Adds packaged shell diagnostics to production update, download, renderer rollout, OSS manifest, release record, and rollback verification. |

Formal release still runs from tag-triggered GitHub Actions. Local package commands prove the build on this machine; they do not replace CI release.

macOS release DMGs embed the stapled app ticket, are rebuilt and re-signed, then notarized and stapled again. This final-byte sequence makes a fresh DMG install launchable when Gatekeeper cannot perform a network ticket lookup; changing that order requires a notarization and offline-launch smoke, not only a local codesign check.

## Current Production Note

The v0.26.1 arm64 isolated smoke reached `window-navigated`, returned `webHealth=ok`, and reported zero missing required resources. Its first fresh-profile run exceeded the 120-second gate while 13 remote MCP servers initialized; a 300-second retry passed. The source contract above removes remote MCP/skill initialization from the listener critical path. `onnxruntime-vad` and `playwright-browser-runtime` remain optional warnings. This source-side correction does not alter or invalidate the already usable v0.26.1 distribution.
