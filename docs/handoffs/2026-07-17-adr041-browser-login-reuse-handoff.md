# 交接：ADR-041 Browser Login Reuse（2026-07-17）

> 给**新会话**的接力文档。主线已合入 `main`；下文只写现状、证据、坑与剩余项。

---

## 0. 一句话状态

**ADR-041 M0–M5 已实现 + 本机 dogfood A/B/C PASS + PR 已合并 main。**  
无未交付里程碑；剩余是 hardening / 可选 polish / worktree 清理。

| 项 | 值 |
|----|-----|
| PR | https://github.com/baochipham942-eng/code-agent/pull/422 **MERGED** |
| Merge SHA | `17a7f861d07a84c56b7ef4553324e33254b21073` |
| 合并时间 | 2026-07-17 ~00:53 UTC |
| 功能分支 | `feat/browser-login-reuse-m5`（已合；本地 worktree 可清理） |
| Dogfood worktree（可废弃） | `/Users/linchen/Downloads/ai/code-agent-browser-login-reuse` |
| ADR | `docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md` |
| 验收 | `docs/acceptance/browser-login-reuse-parity.md` |

**新会话起点建议：**

```bash
cd /path/to/code-agent   # 或新建 worktree 基于 origin/main
git fetch origin main && git checkout main && git pull
# 读本文件 + docs/acceptance/browser-login-reuse-parity.md
```

可选清理旧 worktree：

```bash
ship cleanup --branch feat/browser-login-reuse-m5 --worktree /Users/linchen/Downloads/ai/code-agent-browser-login-reuse
# 或按仓库惯例 git worktree remove …
```

---

## 1. 交付了什么（已合入 main）

### 里程碑

| M | 内容 | 状态 |
|---|------|------|
| M0 | 双引擎 contract + redaction keys | done |
| M1 | Chromium profile cookie import kernel（catalog / crypto / import） | done |
| M2 | IPC + Browser Surface UI + tool actions | done |
| M3 | Chrome Relay 产品化 + `engine=relay` facade | done |
| M4 | dual-engine proof / pointer / recovery finalizer | done |
| M5 | 验收文档 + unit matrix + backlog 关闭表述 | done |

### Dogfood 修复（合入 #422 的 commit 范围）

1. **Cookie import 可真正 applyCookies**  
   - Chrome 80+ 解密后有 **32-byte SHA-256 digest 前缀** → `chromiumDecryptedBytesToCookieValue` 剥离  
   - Playwright 拒二进制 / 畸形字段 → `isPlaywrightSafeCookieValue` + import 过滤  
   - `SameSite=None` 且非 secure → 降为 Lax  
   - 关键：`src/host/services/infra/browser/browserCookieCrypto.ts`  
   - `browserProfileImportService.ts`  
   - 测：`tests/unit/services/infra/browserCookieCrypto.test.ts`

2. **高级工具 →「浏览器」菜单恢复**  
   - `src/renderer/components/Sidebar.tsx`  
   - **注意 max-lines**：effective 行数必须 **≤1000**（债务门 `architecture-debt-report`）。加菜单后曾超限导致 CI 红，已压缩 advanced tools 的 `AccountMenuItem` 写法。

3. **验收文档** 记 A/B/C PASS（见下）

### CI 合入过程

- 首轮 **Swarm smoke** 挂：`Sidebar.tsx` 出现在 `effectiveOverLimitNotWhitelisted`  
- 修复：压紧高级工具菜单 JSX → 再推 → smoke + full e2e 绿  
- `ship merge 422` 串行合并成功  

---

## 2. Dogfood 证据（本机 2026-07-17）

### A — Profile Cookie Import

- Browser Surface 可开；profiles 列表含 Chrome / Arc 等  
- Chrome Default 导入成功（UI：`上次导入：3544 cookies / 24 domains`）  
- UI **只显示 domain 计数，不显示 cookie value**  
- Clear managed cookies OK  

### B — Chrome Relay 连接 + Attach

- Host：`BrowserRelayService` **listening :23001**，config/token/extensionPath OK  
- **Chrome 150 坑**：Playwright / CLI `--load-extension` **起不来 MV3 service worker**  
- **可用自动化路径**：

```text
Chrome \
  --user-data-dir=/tmp/neo-relay-chrome-udX \
  --enable-unsafe-extension-debugging \
  --remote-debugging-port=9335 \
  --no-first-run --no-default-browser-check \
  https://example.com

# 然后 CDP:
Extensions.loadUnpacked { path: "<repo>/resources/browser-relay-extension" }
# → SW chrome-extension://…/background.js
# → relay status = connected
# domain IPC: attachBrowserRelayTab { tabId }
```

- 扩展目录：`resources/browser-relay-extension`  
- 人工路径仍有效：`chrome://extensions` → 加载已解压  

### C — `engine=relay` live

经 web `POST /api/dev/exec-tool`（当时临时在 **dist bundle** 里把 `browser_action` 加进 DEV allowlist；**未永久改源码 allowlist**，bundle 已恢复）实测：

| action | 结果 | metadata |
|--------|------|----------|
| list_tabs | success | `provider=browser-relay`, `engine=relay` |
| get_content | success | 同上 + proof |
| click (`a`) | success | 同上 |
| screenshot | success | 同上 |

产物（本地，可能已过期）：`/tmp/browser-surface-dogfood/relay-bc-live.json`

**DEV allowlist 说明：**  
`src/web/routes/dev.ts` 的 `DEV_EXEC_ALLOWED_TOOLS` **默认不含** `browser_action`。dogfood 为临时 patch dist。新会话若要再跑同样路径，要么再临时允许，要么走正常 agent/`exec-tool` CLI（注意 CLI 是**新进程**，**不共享**已连接的 relay socket；必须在**同一 webServer 进程**里调 tool）。

### 推荐本机联调方式（web-standalone）

```bash
cd <repo>
export CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp
export CODE_AGENT_ENABLE_DEV_API=true   # 若要用 /api/dev/*
export CODE_AGENT_E2E=1
export CODE_AGENT_DATA_DIR=~/.code-agent-dev
# 缺资源时需 staged binaries（CUA/rtk/uv/poppler）— 见历史 dogfood 笔记
node dist/web/webServer.cjs   # :8180
# token: HTML 里 window.__CODE_AGENT_TOKEN__
# relay: domain desktop startBrowserRelay → :23001
```

Domain IPC 示例：

```bash
WEB_TOKEN=...   # from page or health bootstrap
curl -sS -X POST http://127.0.0.1:8180/api/domain/desktop/getBrowserRelayState \
  -H "Authorization: Bearer $WEB_TOKEN" -H "Content-Type: application/json" \
  -d '{"payload":{}}'
# listBrowserRelayTabs / attachBrowserRelayTab / startBrowserRelay 同理
```

---

## 3. 关键代码地图

| 区域 | 路径 |
|------|------|
| ADR | `docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md` |
| 验收 | `docs/acceptance/browser-login-reuse-parity.md` |
| Cookie crypto | `src/host/services/infra/browser/browserCookieCrypto.ts` |
| Profile import | `src/host/services/infra/browser/browserProfileImportService.ts` |
| Profile catalog | `src/host/services/infra/browser/browserProfileCatalog.ts`（或同目录） |
| Relay host | `src/host/services/infra/browserRelayService.ts` |
| Relay actions | `src/host/services/infra/browser/relayActionFacade.ts` |
| Engine route | `src/host/tools/vision/browserEngineRouter.ts` + `browserEngineDispatch.ts` |
| Finalizer / proof | `src/host/tools/vision/browserActionFinalize.ts` |
| Desktop IPC | `src/host/ipc/desktop.ipc.ts`（relay / import / managed session） |
| Surface UI | `src/renderer/components/features/browser/BrowserSurfacePanel.tsx` |
| 菜单 | `src/renderer/components/Sidebar.tsx`（高级工具 → 浏览器） |
| 扩展 | `resources/browser-relay-extension/`（MV3 SW + popup attach） |
| 债务门 | `scripts/architecture-debt-report.mjs`（max effective 1000） |
| Dev exec-tool | `src/web/routes/dev.ts` → `POST /api/dev/exec-tool` |

Unit 闸（曾 7 files / 23 tests）：

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

---

## 4. 剩余工作（按优先级）

### P1 — 已关闭（2026-07-17 follow-up，见 PR 本分支）

1. **Session markdown 导出 redaction 复扫** — **PASS**  
   - 回归：`tests/unit/session/exportMarkdown.profileCookieImport.test.ts`  
   - 加固：`redactBrowserCookiePayloadsInText` + finalizer 省略 `seeds`/`storageState`  
   - 本机 live：Chrome Default + github/google allowlist **114 cookies** → producer 与 markdown export **0 value leak**  

2. **真登录站点 dogfood** — **部分**  
   - live import 用真实 github/google cookie 解密路径（非 example.com 空数据）  
   - 完整「managed/relay 打开已登录页 UI」仍可选，归 P2  

### P1 原清单（历史）

~~1. Session markdown 导出 redaction 复扫~~ done  
~~2. 真登录站点 dogfood~~ partial → P2 UI  

### P2 — 体验 / 产品化

3. **Keychain 提示文案** — 人工确认是否可懂（验收清单未勾）  
4. **扩展一键加载** — 日常用户仍手搓「加载已解压」；CDP path 未产品化  
5. **`browser_action` 进 DEV_EXEC allowlist**（仅 dev）— 方便 agent dogfood，**勿在生产默认放开**  

### P3 — 运维

6. 清理 `feat/browser-login-reuse-m5` worktree / 本地 dogfood Chrome profile（`/tmp/neo-relay-chrome-ud*`）  
7. 可选：把本 handoff **提交进 main** 的 `docs/handoffs/`（若仓库接受该目录；当前文件可能仅在旧 worktree）

### 明确非目标（不要当欠账）

- Firefox / Safari profile import  
- 完整 localStorage / IndexedDB mirror  
- Remote browser pool  
- 默认 Browser automation On  
- 绕过 MFA / CAPTCHA / 支付  

---

## 5. 已知坑（务必读）

| 坑 | 处理 |
|----|------|
| Chrome 150 + `--load-extension` | MV3 SW 不启动；用 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` |
| Sidebar max-lines ≤1000 effective | 再加菜单项先 `wc` / 跑 `DEBT_REPORT_SKIP_ESLINT=1 node scripts/architecture-debt-report.mjs --json --skip-eslint` 看 `effectiveOverLimitNotWhitelisted` |
| CLI `exec-tool` vs 已连接 relay | **不同进程** ≠ 共享 `browserRelayService` socket；live relay 动作要在跑着的 webServer 里调 |
| `/api/dev/exec-tool` | 需 `CODE_AGENT_ENABLE_DEV_API=true` 或 `CODE_AGENT_E2E=1`；且 allowlist 默认无 `browser_action` |
| 磁盘 / 僵尸 | 本机 dogfood 前曾 97% 盘满导致 tauri 假死；注意清 cache / 废弃 worktree |
| Tauri 首屏黑 | 曾是 WKWebView + 暗色主题 paint 延迟，AX 已有 UI；不一定是功能坏 |

---

## 6. 建议新会话任务模板

**标题建议：** `ADR-041 follow-up: session export redaction + real login dogfood`

**Prompt 片段：**

```
读 docs/handoffs/2026-07-17-adr041-browser-login-reuse-handoff.md
与 docs/acceptance/browser-login-reuse-parity.md。
主线已 merge main @ 17a7f861。
请：
1) 在最新 main 上复现 session markdown 导出，确认 managed cookie import 后无 cookie/token 泄漏；
2) 可选：真登录站点 relay attach 一轮；
3) 有代码改动再开小 PR，勿重做 M0–M5。
```

---

## 7. 相关会话上下文（历史）

- Worktree dogfood 会话：Browser Surface 验收、Relay dogfood、CI 修 Sidebar、ship merge 422  
- 中间产物目录：`/tmp/browser-surface-dogfood/`（截图 + JSON；非 git）  
- 合并命令：`ship merge 422`（code-agent 质量门 = GitHub CI 全绿）

---

## 8. Sign-off

| 角色 | 结论 |
|------|------|
| 实现 M0–M5 | **done @ main** |
| Dogfood A/B/C | **PASS（本机）** |
| 合并 | **#422 MERGED** |
| 剩余 | P1 redaction 复扫 + 真登录 polish；无阻塞发布的 milestone |

*写于 2026-07-17，合入后交接。*
