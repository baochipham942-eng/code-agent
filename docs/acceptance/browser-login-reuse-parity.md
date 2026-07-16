# Browser Login Reuse Parity — ADR-041 Acceptance

- **Branch**: `feat/browser-login-reuse-m5`
- **Worktree**: `/Users/linchen/Downloads/ai/code-agent-browser-login-reuse`
- **ADR**: `docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md`
- **Date**: 2026-07-17
- **Status**: code complete for M0–M4; M5 unit gate green; **manual dogfood still required on a real Mac before calling production done**

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

Result: **7 files / 23 tests passed**.

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
|-----------|----------|
| Deny Keychain | fail-closed + recovery hint toward Relay |
| Browser open (DB lock) | copy snapshot path still works, or clear copy-failed message |
| Empty allowlist-filtered import | ok with 0 cookies + warning |

### B. Chrome Relay

1. **Start Relay** → note port + token.
2. **Open extension directory** → Chrome load unpacked extension.
3. Extension popup → **Attach current tab** (logged-in site).
4. Surface **Refresh tabs** → Attach/Detach works.
5. Agent: `browser_action` with `engine: "relay"` for list_tabs / get_content / click.
6. Confirm tool metadata has `provider: browser-relay`, `engineRoute`, `browserComputerProof`, no auth tokens.

### C. Engine auto routing

| Scenario | Expected engine |
|----------|-----------------|
| `http://localhost:…` | managed |
| Attached relay + public URL | relay (auto) |
| Explicit `engine: managed` while relay ready | managed |
| Explicit `engine: relay` while disconnected | fail with recovery, no silent switch |

## Privacy / security audit (code-level)

- [x] Cookie values not returned in list_profiles / import result domains-only summary
- [x] Import requires `userConfirmed: true` (IPC + tool)
- [x] Temp cookie DB copy cleaned in `finally`
- [x] Finalizer redacts authToken / base64-like blobs
- [x] No mounting of user daily `--user-data-dir` (ADR Decision 3)
- [ ] Operator confirms live Keychain prompt copy is understandable (manual)
- [ ] Operator confirms session export/markdown has no cookie values after real import (manual)

## Remaining non-goals (still true)

- Firefox / Safari profile import
- Full localStorage / IndexedDB mirror
- Remote browser pool
- Default Browser automation On
- Bypassing MFA / CAPTCHA / payments

## Sign-off

| Role | Item | State |
|------|------|-------|
| Agent | Unit matrix + docs packaging | done on this branch |
| Human | Manual dogfood A/B/C | **pending** |
| Human | Merge to main after dogfood | pending |

After manual dogfood passes, mark ADR-041 rollout M5 as accepted in the decision log comment and merge `feat/browser-login-reuse-m5`.
