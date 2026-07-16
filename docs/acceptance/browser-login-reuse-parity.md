# Browser Login Reuse Parity — ADR-041 Acceptance

- **Branch**: `feat/browser-login-reuse-m5`
- **Worktree**: `/Users/linchen/Downloads/ai/code-agent-browser-login-reuse`
- **ADR**: `docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md`
- **Date**: 2026-07-17
- **Status**: M0–M5 packaging done; **worktree dogfood 2026-07-17 partial PASS** (kernel + relay host + routing verified on this Mac; full Tauri UI + extension attach still operator)
- **Dogfood worktree**: `/Users/linchen/Downloads/ai/code-agent-browser-login-reuse` @ `feat/browser-login-reuse-m5`

## Scope delivered

| Milestone | Status | Evidence |
|-----------|--------|----------|
| M0 Contract + redaction | done | `desktop.ts` engine/import/recovery types; redaction keys |
| M1 Cookie import kernel | done | catalog / crypto / import service + unit tests |
| M2 Product import path | done | IPC + Browser Surface key UI + tool actions |
| M3 Relay productization | done | extension attach UX + facade + engine=relay |
| M4 Proof / pointer / recovery | done | `browserActionFinalize` shared path |
| M5 Acceptance packaging | this doc + backlog rewrite + unit matrix |

## Automated gate (2026-07-17)

```bash
npx vitest run \
  tests/unit/services/infra/browserCookieCrypto.test.ts \
  tests/unit/services/infra/browserProfileCatalog.test.ts \
  tests/unit/services/infra/browserProfileImportService.test.ts \
  tests/unit/services/infra/relayActionFacade.test.ts \
  tests/unit/tools/vision/browserEngineRouter.test.ts \
  tests/unit/tools/vision/browserEngineRelayRouting.test.ts \
  tests/unit/tools/vision/browserActionFinalize.test.ts
```

Result: **7 files / 23 tests passed** (re-run during dogfood).

## Dogfood log (2026-07-17, this Mac)

### Automated / host-level (no Tauri UI)

| Check | Result | Notes |
|-------|--------|-------|
| Unit gate 23 tests | **PASS** | see above |
| `listBrowserProfiles()` real disk | **PASS** | 11 catalog entries, **4 available**: Chrome Default / Profile 1 / Guest, Arc Default |
| Cookie import Chrome `Default` + allowlist github/google | **PASS** | `imported=30`, `skipped=718`, `domains=6`, ~417ms; Keychain+decrypt OK; result has no cookie values |
| Cookie import Chrome `Profile 1` + same allowlist | **PASS** | `imported=113`, `skipped=3484`, many google/github domains |
| Cookie import Arc `Default` + same allowlist | **PASS (empty)** | `imported=0` (no matching cookies / empty scope for those domains); did not fail-closed incorrectly |
| `userConfirmed=false` gate | **PASS** | `failureCode=not_confirmed` |
| Engine routing matrix | **PASS** | localhost→managed; attached public URL→relay; explicit relay offline→recovery `relay_not_connected` |
| BrowserRelayService boot | **PASS** | `listening` on `23001`, extensionPath resolves to worktree `resources/browser-relay-extension`, HTTP `/api/browser-relay/status` 200, clean stop |
| Extension assets | **PASS** | popup attach/detach handlers present |

### UI / extension attach (still operator)

| Check | Result | Notes |
|-------|--------|-------|
| Tauri app Browser Surface import button | **NOT RUN** | no desktop app launched this session |
| Chrome load unpacked extension + Attach | **NOT RUN** | needs human Chrome UI |
| Agent `engine=relay` live click | **NOT RUN** | needs app + attached tab |
| Session export redaction after real managed applyCookies | **NOT RUN** | host dogfood used stub applyCookies (decrypt only) |

**Interpretation:** Cookie import kernel is **production-credible on this machine**. Relay host + routing + extension packaging are green. End-to-end “open Neo → import → browse logged-in site” and “attach tab → agent click” still need one human UI pass before release copy claims full dogfood.

## Action parity matrix (agent-facing)

| Action | managed | relay | notes |
|--------|---------|-------|-------|
| launch / close | yes | yes (relay start/detach semantics) | relay close detaches tabs, keeps host listening |
| list_tabs / new_tab / navigate | yes | yes | |
| click / click_text / type / press_key / scroll | yes | yes | relay via CDP Runtime.evaluate |
| screenshot / get_content / get_dom / get_a11y | yes | yes | a11y falls back to DOM on relay |
| fill_form / wait | yes | yes | |
| list_profiles / import_profile_cookies / clear_cookies | yes | managed-only | explicit `userConfirmed` for import |
| export/import_storage_state | yes | managed-only | CI/script path |
| set_viewport / upload_file / wait_for_download | yes | unsupported / managed-only | structured capability error |
| proof + pointer + recovery metadata | yes | yes | M4 finalizer |

## Manual dogfood checklist (operator)

### A. Profile Cookie Import

1. Open **Browser Surface**.
2. **Refresh profile list** — expect Chrome/Edge/Brave/Arc… entries when installed.
3. Select a profile → **Import** — grant Keychain once if prompted.
4. Open a site that was logged in on the source browser.
5. Confirm account summary shows domains/counts only (no cookie values in UI/logs).
6. **Clear managed cookies** and confirm logout/empty summary.

Failure expectations:

| Injection | Expected |
|-----------|----