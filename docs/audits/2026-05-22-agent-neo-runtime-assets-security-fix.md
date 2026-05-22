# Audit + Fix Plan — Managed Runtime Assets Security (2026-05-22)

Scope under review: commits `04f73ab1..HEAD` (today's managed-runtime-assets / agent-engine model catalog / persistence-health work). Verified by reading source + running `npm run typecheck` (clean) and 196 targeted tests (pass).

This report is the work order for the fix round. Findings are ordered by the build sequence Ax should follow. **Only the findings listed under "In scope" may be touched. Do not refactor, rename, or change anything outside the named files/functions. Do not edit roadmap/spec docs except the one log line allowed in F5.**

---

## In scope (fix these)

### C1 — CRITICAL: Runtime asset trust root is an unsigned sha256; download path leads to RCE

**Where:** `src/main/services/cloud/updateService.ts:593-648` (`prepareRuntimeAssets`), `:540-585` (`downloadVerifiedFile`); manifest produced by `scripts/build-runtime-assets.mjs:290-345` (`writeManifest`); metadata derived in `vercel-api/lib/updateMetadata.ts` (`runtimeAssetsMetadataFromRelease`, env `RUNTIME_ASSETS_MANIFEST_SHA256`). Downloaded archives are extracted and `require()`'d as native code via `src/main/runtime/runtimeAssetResolver.ts` + `nodeModuleLoader.ts:38`.

**Problem (verified):** The entire integrity chain — update-API JSON → `manifestSha256` → `manifest.json` → per-asset `archiveSha256` → archive bytes → `require()` — is anchored only to a sha256 that the update server supplies in plaintext. `grep -niE "ed25519|signature|verify|pubkey"` across `updateService.ts` and all of `src/main/runtime/` returns nothing. Anyone who can serve/MITM the update API, compromise the OSS bucket / GitHub release, or leak `RUNTIME_ASSETS_MANIFEST_*` env can ship a malicious archive with a matching malicious sha256 and obtain remote code execution in the desktop main process. The lower-risk model catalog built the same day IS Ed25519-signed; this higher-risk download-and-execute path is not.

**Required fix — reuse the existing control-plane envelope (do NOT invent new crypto):**
1. Add envelope kind `runtime_assets_manifest` to the kind union in both `vercel-api/lib/controlPlaneEnvelope.ts` and `src/main/services/cloud/controlPlaneTrust.ts`.
2. Sign the runtime `manifest.json` payload at publish time with the **control-plane private key** (same key/env path `controlPlaneEnvelope.ts:161-181` already uses). Two acceptable wirings — pick the one that fits the release flow with least change:
   - (preferred) Have `scripts/build-runtime-assets.mjs` emit the manifest wrapped in a control-plane envelope when a signing key is available (env `CONTROL_PLANE_SIGNING_KEY`, fail closed / refuse to publish a signed-channel build if the key is absent), OR
   - serve the manifest through the signed `/api/v1/control-plane?artifact=runtime_assets_manifest` endpoint like the model catalog.
3. Client: in `prepareRuntimeAssets`, after downloading the manifest, **verify the control-plane envelope via `controlPlaneTrust` (signature + kind === 'runtime_assets_manifest' + expiry + contentHash) BEFORE reading any hash out of it.** Only the verified payload's `archiveSha256` values may be trusted. Fail closed (skip install, surface diagnostics) when the manifest is unsigned/untrusted; never fall through to the old sha256-only path on a signed channel.
4. Keep the transport `manifestSha256` check as defense-in-depth, but the **signature is the authoritative gate**.

**Acceptance:**
- New unit test (generate a real ed25519 keypair, like `agentEngineModelCatalog.test.ts` does): a manifest with a **valid** signature installs; a manifest with a **forged/absent signature** but a self-consistent `manifestSha256` is **rejected, nothing installed**.
- New unit test: wrong `kind` envelope on the manifest is rejected.
- Existing runtime installer/extraction tests stay green.

### C1b — HIGH (same trust path): redirect follows `http://` → TLS downgrade

**Where:** `src/main/services/cloud/updateService.ts:823-828` (`httpGet`) and `:894-901` (`downloadFile`): a 301/302 `Location` is followed verbatim; protocol is re-derived per hop (`:808`, `:865`), so `Location: http://…` strips TLS.

**Required fix:** On redirect, reject any scheme downgrade — if the original request was `https:`, refuse to follow a non-`https:` `Location`. Apply to both helpers. (Fix alongside C1: same fetch path.)

**Acceptance:** unit test — an https request that receives a 302 to an `http://` location rejects rather than following.

### H2 — HIGH: `active.json` is trusted at load time with no containment check or hash re-verify (TOCTOU)

**Where:** `src/main/runtime/runtimeAssetResolver.ts:115-121` resolves `active.json`'s `root` straight into a path that `nodeModuleLoader.ts:38` then `require()`s. Verification happens only at install time; the unprotected `~/Library/Application Support/code-agent/runtime/active.json` is read and executed blindly later.

**Required fix:** In the resolver, enforce `ensureInside(runtimeBaseDir, root)` (reject roots that escape the managed base dir) before returning a path for `require()`. Verification of the install record's `expandedSha256` at load time is desirable but the containment check is the must-have. Do not change the installer's (correct) verify-before-promote logic.

**Acceptance:** unit test — an `active.json` whose `root` points outside `runtimeBaseDir` is rejected by the resolver (no path returned for require).

### M3 — MED: migration CHECK-constraint edit won't reach already-migrated databases

**Where:** `supabase/migrations/20260517000000_control_plane_governance.sql:31-33` — `agent_engine_model_catalog` was added to the `artifact_kind` CHECK **inside an existing `CREATE TABLE IF NOT EXISTS`**. DBs where 20260517 already ran will skip it; a production INSERT of the new kind will hit a CHECK violation.

**Required fix:** Add a **new** dated migration `supabase/migrations/20260522000000_agent_engine_catalog_kind.sql` that idempotently drops and re-adds the `artifact_kind` CHECK constraint to include `agent_engine_model_catalog` (guard with `IF EXISTS` / catalog lookup so it is safe on both fresh and migrated DBs). Leave the 20260517 file as-is (it keeps fresh DBs correct). Do not touch existing rows.

**Acceptance:** the new migration applies cleanly on (a) a DB that already has the 20260517 table and (b) a fresh DB; INSERT of `agent_engine_model_catalog` succeeds after it.

### M4 — MED: DB retry self-heal never re-marks persistence available

**Where:** `databaseService.ts` retry path logs `"Database recovered"` (`:127`) on a successful retry but never calls back into `setDbAvailable(true)`. Web write paths gate on `dbAvailable` (`agent.ts:725,825`, `webServer.ts:739,915`), so after a transient init failure that later recovers, `/api/health` stays `durable=false` AND writes keep going to memory for the process lifetime.

**Required fix:** On retry success, re-invoke the same path that `webServer.ts:496` uses to mark DB available (`setDbAvailable(true)`), clearing the stale unavailable state. Use a callback/observer rather than importing web state into the DB layer if that would cross a layer boundary; match existing wiring.

**Acceptance:** unit test — simulate init failure then a successful retry, assert `getPersistenceHealth()` flips to `durable=true` / `mode='database'`.

### M5 — MED: missing negative tests on the existing weak gates

Fold into the above where natural; otherwise add as standalone:
- Service-layer `manifestSha256` mismatch (`downloadVerifiedFile`) is currently never exercised with tampered bytes — add a negative test asserting `prepareRuntimeAssets` aborts and installs nothing. (Becomes partly redundant once C1 lands, but keep the transport-layer test.)
- Catalog verifier: add `invalid_signature` (well-formed envelope, forged signature, **matching** configured pubkey → rejected) and `kind_mismatch` tests in `controlPlaneTrust.test.ts` / `agentEngineModelCatalog.test.ts`.

---

## Out of scope (do NOT touch this round)
- LOW: UpdateSettings runtime-asset UI strings hardcoded Chinese (i18n consistency) — defer.
- LOW: control-plane pubkey trust-anchor `cwd`/argv-dir paths — defer (add a doc comment only if trivial; otherwise skip).
- `'.code-agent'` literal in `webServer.ts` — pre-existing, not introduced today; leave it.
- The Tauri app-updater signed path (`.app.tar.gz + .sig`) — unchanged, correct.

## Build sequence
C1 + C1b together (same fetch/trust path) → H2 → M3 → M4 → M5. **One commit per finding.** TDD: write the failing test first, then the fix. Run `npm run typecheck` before each commit.

## Guardrails (hard)
- Scope locked to the files/functions named above. No opportunistic refactors/renames.
- Reuse existing crypto (`controlPlaneEnvelope` / `controlPlaneTrust`); do not hand-roll signature code.
- No edits to `docs/plans/2026-05-22-managed-runtime-assets-roadmap.md` or the spec files.
- Constants from `src/shared/constants.ts` per repo rules; no new hardcoded provider/model/timeout/path literals.
- Stop and report if a fix needs to grow beyond its named scope.

## Operator follow-up
~~C1 needs the control-plane private key provisioned as a release-pipeline secret~~ — **DONE by Claude.** A
dedicated Ed25519 keypair was generated and provisioned to GitHub Actions secrets:
`CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY`, `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY`, `CODE_AGENT_CONTROL_PLANE_KEY_ID`
(keyId `agent-neo-runtime-202605`). Private key never left local generation → `gh secret set` (stdin).

Remaining (genuinely deferred, not blocking): wiring `build-runtime-assets` into `release.yml` with the
signing env is only needed WHEN runtime-asset publishing is actually turned on (Stage 7 is not wired into the
workflow yet). Until then the system is safe by default: the client fail-closes on any unsigned/untrusted
manifest, so no runtime assets are delivered rather than trusted unsigned.

## Resolution (all findings fixed + verified)

| Finding | Commit | Verification |
| --- | --- | --- |
| C1 (CRITICAL) | `dd488076` | sign+verify via control-plane envelope in both verification sites; 200+ tests; monitor caught + fixed an unsigned-fixture regression in `updateServiceRuntimeAssets.test.ts` |
| C1b (HIGH) | `62a73fad` | https→http redirect rejected in both httpGet/downloadFile; asserts no plaintext request |
| H2 (HIGH) | `95fb23bb` | resolver containment via active-manifest dir; monitor corrected a hardcoded-base bug + 2 unrealistic fixtures |
| M3 (MED) | `1296dc58` | name-agnostic idempotent migration; verified on a real PostgreSQL 15 (stale-4-kind → fixed, idempotent, 5-kind clean) |
| M4 (MED) | `d2f2c6df` | DB recovery observer re-marks persistence; no DB→web layer inversion |
| M5 (MED) | `618213b6` | `invalid_signature` + `kind_mismatch` verifier reject coverage |

Bonus (pre-existing breakage from today's agent-engine catalog work, found in the final sweep): `42d87916`
repairs the `agentRouter` test mock missing `getRemoteAgentEngineModelCatalogService`.

Final state: 286/286 tests green across all touched areas, `tsc --noEmit` clean. Not pushed.
