# Browser Login Reuse Parity — ADR-041 Acceptance

- **Branch**: `feat/browser-login-reuse-m5`
- **Worktree**: `/Users/linchen/Downloads/ai/code-agent-browser-login-reuse`
- **ADR**: `docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md`
- **Date**: 2026-07-17
- **Status**: M0–M5 packaging done; **worktree dogfood 2026-07-17 PASS (A+B+C)** — import, Chrome Relay attach via CDP `Extensions.loadUnpacked`, and `engine=relay` live actions verified on this Mac
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

### UI / extension attach / live relay (2026-07-17 night dogfood)

| Check | Result | Notes |
|-------|--------|-------|
| Tauri / app-host Browser Surface import | **PASS** | Opened Surface, listed Chrome/Arc profiles, imported Chrome Default → `上次导入：3544 cookies / 24 domains`, UI shows domains only (no values), clear cookies OK |
| Live applyCookies into managed Chrome CDP | **PASS after fix** | Was failing `Storage.setCookies: Invalid cookie fields` until Chrome 80+ 32-byte digest strip + Playwright-safe field filter |
| Sidebar 高级工具 →「浏览器」菜单 | **PASS** | Restored in `Sidebar.tsx`; dogfood sees 模型训练/时间与能力/桌面采集/**浏览器** |
| Chrome Relay host listen/config | **PASS** | `:23001` listening, token/extensionPath OK |
| Chrome load unpacked extension + WS connect | **PASS** | Chrome 150: CLI `--load-extension` broken; **CDP `Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging`** works → SW `chrome-extension://ipbidahl…/background.js`, relay `status=connected` |
| Attach tab (example.com) | **PASS** | `attachBrowserRelayTab` → `attachedTabCount=1`, reason: Agent can use engine=relay |
| Agent `engine=relay` live actions | **PASS** | Via `/api/dev/exec-tool` (temp allowlist for dogfood): `list_tabs` / `get_content` / `click(a)` / `screenshot` all success; metadata `provider=browser-relay`, `engine=relay`, `engineRoute.reason=explicit_relay`, `browserComputerProof` present |
| Session export redaction after real managed applyCookies | **PARTIAL** | UI/API import result redacted; full session markdown export not re-checked this pass |

**Interpretation:** Dogfood **A** (import + crypto), **B** (extension connect + attach), **C** (`engine=relay` live) all green on this Mac. Playwright `--load-extension` still flaky on Chrome 150; automation path is CDP `Extensions.loadUnpacked`. Artifact: `/tmp/browser-surface-dogfood/relay-bc-live.json`.

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
| Agent | Unit matrix + docs packaging | done |
| Agent | Host-level dogfood (catalog/import/keychain/decrypt/relay boot/routing) | **PASS 2026-07-17** |
| Human / agent | UI dogfood A (Surface import + managed applyCookies) | **PASS 2026-07-17** (3544 cookies / 24 domains; crypto fix landed) |
| Agent | Menu 高级工具→浏览器 | **PASS** (`Sidebar.tsx` restored) |
| Agent | Relay host listen/config/extension path | **PASS** (:23001 listening, token, extension dir) |
| Agent | Playwright `--load-extension` connect | **FAIL on Chrome 150** (MV3 SW never starts); use CDP `Extensions.loadUnpacked` instead |
| Agent | UI dogfood B attach + C engine=relay | **PASS 2026-07-17** (CDP loadUnpacked + attach + live actions) |
| Human | Merge to main after CI green | via PR #422 |

### Operator Relay attach (manual path, still valid)

1. Neo → 用户菜单 → 高级工具 → **浏览器** → **启动 Relay**
2. **打开扩展目录** → Chrome `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `resources/browser-relay-extension`
3. 扩展应自动拉 `http://127.0.0.1:23001/api/browser-relay/config` 并显示 ON
4. 打开已登录站点 → 扩展 popup → **Attach current tab**
5. Surface **刷新标签** → 应见 attached；Agent `browser_action` + `engine: "relay"`

Dogfood A/B/C green on worktree; remaining manual polish: session markdown export redaction re-check, Keychain prompt copy, real logged-in site attach.
