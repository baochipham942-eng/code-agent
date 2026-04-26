# Browser Use Productization Roadmap

日期：2026-04-26
状态：Phase 1-6 已按最小闭环实现并通过定向验收；Phase 5 受硬边界约束，只落 in-app managed browser 的 lease / proxy schema / crash cleanup / external bridge unsupported 基线。
范围：in-app managed browser 优先；desktop / external browser 只纳入可复用账号态、CDP/profile/extension bridge 与人工接管边界。
关联验收：[browser-computer-workbench-smoke.md](/Users/linchen/Downloads/ai/code-agent/docs/acceptance/browser-computer-workbench-smoke.md)

## 0. 实施状态

这份文档保留原始 roadmap 和 Phase 1 提示词作为历史上下文。当前实现按用户硬边界收敛在 in-app managed browser：

- Phase 1：BrowserSession + Profile 基线已落地，persistent 默认兼容 `managed-browser-profile`，isolated profile close 后安全清理。
- Phase 2：DOM snapshot 已带 `snapshotId` / `targetRef`，`browser_action.click/type` 支持 targetRef，stale ref 返回 recoverable metadata。
- Phase 3：AccountState summary、storageState import/export、`secretRef` 和 typed text 源头脱敏已落地。
- Phase 4：download/upload artifact 已落地，artifact 只暴露 name/hash/mime/size/session 摘要。
- Phase 5A：未做远程池、外部 CDP attach、外部 profile 或 extension bridge；只做 session lease/TTL、crash cleanup、proxy schema 与 external bridge unsupported 状态。
- Phase 6：本地 browser task benchmark 已落地，覆盖 navigation、form、extract、login-like、download/upload、failure recovery、redaction export，并支持 fixture-only trace -> recipe draft -> rerun。

当前完成定义：

`in-app managed browser 可以承担本地受控工作流和产品化验收；external / remote browser 仍是明确未交付边界。`

本文后面的“差距清单”和“目标架构”保留了原始设计语境，但涉及 BrowserSession、TargetRef、AccountState、download/upload、lease/proxy 的条目，已经按本节实施状态从 Missing 变成 Present。

## 1. 核心判断

`code-agent` 当前的 in-app managed browser 已经从 smoke 与工作台集成级推进到本地受控生产化基线；external / remote browser 仍保持未交付边界。

已经补齐的主线是生产级 browser agent 必须具备的会话生命周期；后续优先补多 session、账号恢复、真实站点人工接管和 durable trace，而不是继续只在动作表面加功能：

- `BrowserSession`
- `Profile / AccountState`
- `Snapshot / TargetRef`
- `Action Preview`
- `Trace / Recovery`
- `Artifact`
- `Recipe / Workflow`
- `Eval`

推进顺序应当先围绕 in-app managed browser 补齐这些基础对象。desktop / external browser 只做账号态复用、当前桌面浏览器 context、Chrome profile / CDP / extension bridge 和人工接管入口，不把产品方向扩成独立 RPA 平台。

## 2. 当前成熟度判断

| 模块 | 当前成熟度 | 主要证据 | 判断 |
| --- | --- | --- | --- |
| in-app managed browser | 本地受控生产化基线 | [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:140), [browserProvider.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserProvider.ts:19), [browserAction.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts:21) | 已有 BrowserSession/Profile/AccountState/TargetRef/Artifact/Lease/Proxy/trace/recovery/benchmark；仍不做 remote pool。 |
| desktop / external browser | 桌面上下文和 OS browser 操作级 | [BrowserTool.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/BrowserTool.ts:69), [useWorkbenchBrowserSession.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useWorkbenchBrowserSession.ts:184) | 有 OS 导航、前台浏览器上下文、desktop readiness；外部 Chrome profile / external CDP / extension bridge 仍未交付。 |
| computer surface | fallback 与安全执行层较完整 | [computerUse.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/computerUse.ts:27), [computerSurfaceGating.test.ts](/Users/linchen/Downloads/ai/code-agent/tests/unit/tools/vision/computerSurfaceGating.test.ts:273) | read action、foreground approval、background AX / CGEvent、失败分类已成型；适合作为 fallback 和 desktop app 支撑，不适合作为 browser 主路径。 |

## 3. 差距清单

### Still Missing

| 缺口 | 当前状态 | 影响 |
| --- | --- | --- |
| 多 session | 当前只有一个 browser/context，多个 tab 共享同一上下文。 | 并行任务、不同账号、崩溃回收、租约都无法可靠表达。 |
| 远程浏览器池 | provider 只有本地 System Chrome CDP 和 Playwright bundled。 | 外部 CDP、自建 browser service、Browserbase/Skyvern Cloud 只能临时接，不能产品化。 |
| External browser bridge | 当前状态明确为 `unsupported`。 | 不能复用用户外部 Chrome profile / cookies，也不做外部 CDP attach。 |
| 反 bot / CAPTCHA 边界 | 无风险识别、人工接管、CAPTCHA 状态。 | 真实网站任务失败时无法给出产品化分流。 |

### Present But Incomplete / 已补齐基础

| 能力 | 已有基础 | 不完整点 |
| --- | --- | --- |
| BrowserSession | session/profile/workspace/artifact/lease/proxy/accountState 字段已进入 `ManagedBrowserSessionState`。 | 多 context / 多任务并行仍未做。 |
| Persistent / isolated profile | persistent 兼容旧 profile；isolated profile close 后清理。 | 完整 profile 管理 UI 未做。 |
| AccountState | storageState import/export、cookie/localStorage/sessionStorage summary、expired cookie 分类已落。 | 不展示 raw cookie/storage；真实账号过期恢复仍需后续 UI。 |
| Download / Upload | 本地 fixture download/upload artifact 已落地并有 hash/name/mime/size 摘要。 | 大文件、敏感文件确认、真实网站文件流仍需扩展。 |
| Proxy | per-session proxy schema、system Chrome proxy args、credentialed proxy URL 拒绝已落。 | 地区出口诊断和复杂 bypass UI 未做。 |
| TargetRef | snapshotId + targetRef + stale recovery metadata 已落。 | 不承诺跨页面长期稳定；self-healing 仍是局部恢复。 |
| Workflow / Eval | browser task benchmark 已覆盖 7 类本地 fixture。 | 还不是云端/真实网站 workflow 平台。 |
| Trace | `beginTrace / finishTrace` 有 before/after、console/network failures、参数脱敏。[browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:700) | 只保留进程内 last 100，无 durable trace、resume、recipe。 |
| Redaction | [browserComputerRedaction.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/utils/browserComputerRedaction.ts:1) 覆盖 typed text、form data、raw metadata。 | 继续守住新 surfaces，不把后续 action 新字段绕过脱敏层。 |
| Recovery | [desktop.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/desktop.ipc.ts:38) 有 managed recovery snapshot。 | 只有 DOM/a11y 摘要，没有 recovery plan、ref resolve、retry path。 |
| Renderer readiness | [useWorkbenchBrowserSession.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useWorkbenchBrowserSession.ts:156) 能展示 session/readiness/repair/profile/account/artifact/lease/proxy。 | 还没有完整 account/profile 管理面。 |

## 4. 目标架构

| 层 | 推荐形态 | 现有接法 |
| --- | --- | --- |
| `BrowserSession` | `sessionId`, `profileId`, `contextId`, `tabIds`, `lease`, `ttl`, `workspaceScope`, `artifactDir`, `provider`, `proxy`, `allowedHosts`, `blockedHosts`。 | 先扩 [desktop.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/desktop.ts:119) 与 [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:140)，后续再拆 `BrowserSessionManager`。 |
| `Profile / AccountState` | `persistent`, `isolated`, `storageState`, `cookie/localStorage/sessionStorage import/export`, `expiresAt`, `scope`。 | 从当前 `profileDir` 抽 `profile resolver`。 |
| `Snapshot` | DOM/a11y 为主，screenshot 为辅助；snapshot 带 `snapshotId`, `url`, `title`, `frame`, `capturedAt`。 | 扩 [getDOMSnapshot](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:548) 与 a11y snapshot。 |
| `TargetRef` | `refId`, `source`, `selector`, `role`, `name`, `textHint`, `frameId`, `tabId`, `snapshotId`, `ttl`, `confidence`。 | 从 DOM/a11y interactive elements 派生。 |
| `Action` | `navigate`, `click`, `typeSecret`, `fill`, `select`, `extract`, `upload`, `downloadWait`, `handoff`, `devtools`。 | 扩 [browserAction.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts:21) 与 [browserComputerActionPreview.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/utils/browserComputerActionPreview.ts:253)。 |
| `Trace` | durable trace：action、snapshot、redacted input、network summary、artifact、failure、recovery attempts。 | 从 `WorkbenchActionTrace` 增量扩展。 |
| `Recovery` | re-snapshot -> TargetRef resolve -> observe alternatives -> visual locate fallback -> manual takeover -> unrecoverable。 | 接 [ToolDetails.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails.tsx:228) 的 repair action。 |
| `Recipe / Workflow` | 成功 trace 生成轻量 recipe，参数化 URL、schema、target refs 和期望输出。 | 复用 workbench preset / recipe store，不做大型 workflow builder。 |
| `Eval` | 本地 browser task benchmark，覆盖 navigation、form、extract、login-like、download、recovery、redaction。 | 新增 acceptance script，挂入 [browser-computer-suite.ts](/Users/linchen/Downloads/ai/code-agent/scripts/acceptance/browser-computer-suite.ts:107)。 |

## 5. 生产路径能力规划

| 能力 | 当前基础 | 缺什么 | 推荐模块 | Phase 1 做不做 | 验收证明 |
| --- | --- | --- | --- | --- | --- |
| 账号态 | 固定 profileDir；System Chrome CDP 支持 user-data-dir。 | persistent / isolated profile、storageState、cookie/localStorage/sessionStorage import/export、workspace/session 隔离、过期检测。 | `browserService` profile resolver，后续 `browserProfileStore`。 | 做 profileMode/session 字段；不做完整 storage export。 | mock login 在 persistent profile 保留；isolated profile 不共享 cookie。 |
| 凭据 | redaction 已覆盖 typed text、form data、敏感 key。 | password/token/2FA/TOTP/email code/manual takeover 产品路径；`secretRef`。 | `browserAction` + credential resolver + redaction。 | 只修源头输出不含 raw typed text；secretRef 放 Phase 3。 | replay/markdown/json/export/log 中无 password/token/cookie。 |
| 下载 / 上传 | 有 screenshotDir；download disabled。 | download dir、artifact archive、命名、完成检测、失败恢复、file chooser、敏感文件确认。 | `browserService` download handler + artifact service + `browserAction`。 | 不做。 | 本地 download fixture 校验 name/hash/artifact；upload fixture 校验文件选择和确认。 |
| 多 session | 单 browser/context，多 tab。 | 多 context、多任务并行、lease/TTL、crash recovery、任务绑定 trace/profile。 | `BrowserSessionManager`。 | 不做。 | 两个 benchmark task 并行，cookie/profile/trace 不串。 |
| 远程浏览器池 | local System Chrome CDP / Playwright bundled。 | external CDP endpoint、自建 browser service、Browserbase/Skyvern Cloud adapter、health、lease、recycle、cost/log。 | `browserProvider` provider registry + session lease。 | 不做。 | fake remote adapter lease/recycle；真实 endpoint 只用 env-gated smoke。 |
| 代理 | allow/block host guard。 | per-session proxy、region/egress、proxy bypass、失败诊断、与 allow/block hosts 的关系。 | provider launch/context options + policy classifier。 | 不做。 | proxy config 可回显；bypass 生效；DNS/proxy/blocked host 分类可测。 |
| 反 bot / CAPTCHA | console/network failure 可记录。 | 风控失败识别、CAPTCHA 状态、人工接管、stealth/proxy 插槽。 | recovery classifier + renderer handoff。 | 不做。 | CAPTCHA-like fixture 归类为 `manual_takeover_required`，不自动求解。 |
| 外部浏览器 | OS browser actions、frontmost desktop context、computer surface。 | Chrome profile / external CDP attach / extension bridge、账号态复用边界、授权与隔离。 | `externalBrowserBridge` 或 provider cap。 | 不做。 | 外部 attach 只读；managed profile 不能读取 external cookies；bridge 需要显式授权。 |

## 6. Roadmap

### Phase 1：BrowserSession + Profile 基线

目标：

- 给 managed browser 引入稳定 session/profile 身份。
- 默认行为保持兼容，不动远程池、不动完整账号态。

文件范围：

- [desktop.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/desktop.ts:119)
- [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:140)
- [browserProvider.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserProvider.ts:111)
- [desktop.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/desktop.ipc.ts:38)
- [useWorkbenchBrowserSession.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useWorkbenchBrowserSession.ts:156)

最小实现：

- `ManagedBrowserSessionState` 增加 `sessionId`, `profileId`, `profileMode`, `workspaceScope`, `artifactDir`。
- `ensureManagedBrowserSession` 支持 `profileMode=persistent|isolated`。
- `browserService` 把当前固定 profileDir 改成 resolver 输出，默认仍是现有 persistent path。
- renderer preview 展示 profile mode 和 session id。

验收：

- unit：profile resolver 默认 path 兼容；isolated 目录不同且可清理。
- renderer：managed session preview 显示 profile/session 状态。
- acceptance：现有 `browser-computer-workflow` 仍通过，provider 优先 `system-chrome-cdp`。

风险：

- 旧 profile 目录不能迁移出错。
- isolated profile 清理不能误删 persistent profile。

### Phase 2：Snapshot / TargetRef / Action Preview

目标：

- 从“读到 DOM/a11y”推进到“可以复用、预览、回放的目标引用”。

文件范围：

- [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:548)
- [browserAction.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts:21)
- [browserComputerActionPreview.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/utils/browserComputerActionPreview.ts:253)
- [browserComputerRedaction.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/utils/browserComputerRedaction.ts:1)

最小实现：

- snapshot 增加 `snapshotId`。
- interactive elements 增加 `targetRef`。
- action params 支持 `targetRef`。
- action preview 展示 target label、ref source、snapshot age。

验收：

- local fixture 中通过 `targetRef` click。
- stale ref 失败时返回可恢复错误，并建议 refresh snapshot。
- typed action 输出不含 raw typed text。

风险：

- ref 稳定性不要过度包装成跨页面长期有效。

### Phase 3：AccountState + Credential Path

目标：

- 补齐账号态导入导出和凭据输入边界。

文件范围：

- `browserService` / profile resolver
- [browserAction.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts:21)
- [browserComputerRedaction.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/utils/browserComputerRedaction.ts:1)
- IPC + renderer session preview

最小实现：

- storageState import/export。
- cookies/localStorage/sessionStorage summary。
- `secretRef` 输入，不把 secret 交给 trace、markdown、replay。
- login-like mock fixture。

验收：

- mock login 持久化后可恢复。
- storageState export/import 成功。
- export/replay/log 中无 cookie value、password、token。
- 过期 cookie 触发 `account_state_expired`。

风险：

- cookie/storage 属于高敏数据，默认展示只能是 summary。

### Phase 4：Download / Upload + Artifact

目标：

- 让下载、上传和文件产物成为 browser agent 的一等能力。

文件范围：

- [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:752)
- [browserAction.ts](/Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts:21)
- artifact registry / session workspace
- renderer recovery 和 action preview

最小实现：

- per-session download dir。
- download complete detection。
- artifact name/hash/mime/size。
- `upload_file` 支持 file chooser。
- 敏感文件上传需要确认。

验收：

- local download mock 生成文件，校验 hash 和 artifact。
- broken download 有 failure reason。
- upload mock 读回文件名和 hash。

风险：

- 下载目录不能和用户目录混用。
- 上传文件选择不能静默越权。

### Phase 5：Multi-session + Remote / Proxy / External Bridge

当前实现按本轮硬边界收敛为 Phase 5A：优先 in-app managed browser，不做远程浏览器池、不做外部 Chrome profile/CDP/extension bridge。下列远程/外部能力仍是后续 backlog，不计入本轮关账。

目标：

- 把 session lease、远程浏览器、代理、外部浏览器账号态复用纳入同一个边界。

文件范围：

- [browserProvider.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserProvider.ts:19)
- `BrowserSessionManager`
- IPC / renderer session panel
- external browser bridge

最小实现：

- 多 context / 多 session registry。
- session lease / TTL / crash cleanup。
- external CDP endpoint provider。
- per-session proxy schema。
- external browser bridge 只读模式。

验收：

- 两个 session 并行执行 local fixture，cookie/trace/artifact 不串。
- fake remote browser provider 能 health check、lease、recycle。
- proxy bypass 配置可测。
- external browser attach 必须显式授权。

风险：

- external browser profile 泄露风险高。
- remote pool 成本和日志边界必须独立记录。

### Phase 6：Recovery / Recipe / Eval

目标：

- 把成功 trace 沉淀成轻量 recipe，把失败 trace 变成可恢复诊断。

文件范围：

- `scripts/acceptance/browser-task-benchmark.ts`
- [browser-computer-suite.ts](/Users/linchen/Downloads/ai/code-agent/scripts/acceptance/browser-computer-suite.ts:107)
- replay / review / eval 相关模块
- workbench preset / recipe store

最小实现：

- browser task benchmark。
- recovery report。
- trace -> recipe draft。
- recipe runner 只支持本地 fixture 和受控 URL。

验收：

- benchmark 覆盖 7 类任务。
- replay 能展示 action、snapshot、artifact、failure、recovery attempts。
- recipe 重跑能通过固定 local fixture。

风险：

- 不能扩成大型 no-code workflow builder。

## 7. Browser Task Benchmark

新增：

```bash
npm run acceptance:browser-task-benchmark -- --provider system-chrome-cdp
```

默认走系统 Chrome headless + CDP；所有 fixture 都在本地 HTTP server 或 data URL 中完成，不依赖外部网络。

| Case | 覆盖点 | 通过标准 |
| --- | --- | --- |
| `BT-01 navigation_snapshot` | navigate、DOM/a11y snapshot、TargetRef | 页面标题、heading、targetRef 都可读。 |
| `BT-02 form_fill` | click/type/fill、typed text redaction | 表单提交成功；trace/export 不含原文输入。 |
| `BT-03 extract_schema` | schema extract | 输出符合 JSON schema。 |
| `BT-04 login_like_mock` | cookie/localStorage/sessionStorage、expiry | persistent profile 可恢复；isolated 不共享；过期可识别。 |
| `BT-05 download_upload_mock` | download complete、artifact、upload file chooser | 下载 hash 正确；上传回读文件名和 hash。 |
| `BT-06 failure_recovery` | stale target、re-snapshot、retry | stale action 给出 recovery path；刷新后成功。 |
| `BT-07 redaction_export` | replay/markdown/json redaction | 无 secret、cookie value、token、screenshot base64。 |

## 8. 安全边界

| 数据 | 规则 |
| --- | --- |
| typed text | tool 源头只返回长度、selector、secretRef 状态；不拼 raw text。 |
| credentials | password、token、TOTP、邮箱验证码、手动接管内容统一走 `secretRef` 或 takeover；不进入 trace、replay、markdown、json export。 |
| cookies / storage | import/export 必须显式触发；默认只展示 domain、expires、count、scope，不展示 value。 |
| screenshots | screenshot base64 不进 history/export；敏感模式可禁用 screenshot/vision，只保留受控 artifact 路径。 |
| external browser profile | 默认只读；显式授权后 attach；不复制用户 Chrome cookies 到 managed profile。 |
| downloads | per-session artifact dir；敏感文件名和路径按 artifact policy 展示。 |
| uploads | 用户文件上传需要确认，特别是 home、Downloads、Desktop、SSH key、env、credential 文件。 |
| proxy / remote pool | session config 中记录 provider、region、egress、cost hint；失败分类必须区分 proxy、DNS、blocked host、site risk。 |

## 9. 外部参考吸收边界

| 来源 | 可吸收 | 暂缓 |
| --- | --- | --- |
| [Playwright MCP](https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md) | accessibility snapshot、target ref、profile/storage/caps、CDP endpoint、extension。 | 直接照搬 MCP tool surface。 |
| [Stagehand observe](https://docs.stagehand.dev/v3/basics/observe), [act](https://docs.stagehand.dev/v3/basics/act), [extract](https://docs.stagehand.dev/v3/basics/extract) | observe -> preview -> act、schema extract、action cache/self-healing。 | 多步 agent loop 直接替换现有 runtime。 |
| [browser-use CLI](https://docs.browser-use.com/open-source/browser-use-cli), [authentication](https://docs.browser-use.com/open-source/customize/browser/authentication) | persistent session、Chrome profile、storage state、TOTP/email code、custom tools、benchmark。 | 大而全 browser CLI 产品面。 |
| [Skyvern run_task](https://www.skyvern.com/docs/sdk-reference/tasks/run-task), [README](https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/README.md), [TOTP API](https://docs-new.skyvern.com/docs/api-reference/credentials/send-totp-code) | task result、downloaded files、recording/screenshot/failure reason、credential/TOTP/download/upload 路径。 | no-code workflow builder、云端 RPA 平台、CAPTCHA/anti-bot 承诺。 |
| [Midscene](https://raw.githubusercontent.com/web-infra-dev/midscene/main/README.md) | visual locate fallback、跨界面思路、debug/replay report。 | 纯视觉优先路线。 |

## 10. 原下一轮最小实施切片（历史）

先做 `Phase 1：BrowserSession + Profile 基线`。

理由：

- 账号态、下载、远程池、多 session、trace 都需要 session/profile 身份。
- 这一阶段不碰高敏 cookie value，也不碰远程池和外部浏览器，风险低。
- 做完后，后续每个生产路径能力都有挂载点。

改动范围：

- [desktop.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/desktop.ts:119)
- [browserService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts:140)
- [browserProvider.ts](/Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserProvider.ts:111)
- [desktop.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/desktop.ipc.ts:38)
- [useWorkbenchBrowserSession.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useWorkbenchBrowserSession.ts:156)
- unit / renderer tests for profile/session display and compatibility

建议测试：

```bash
npx vitest run \
  tests/unit/services/infra/browserProvider.test.ts \
  tests/unit/services/infra/browserServiceTraceRedaction.test.ts \
  tests/unit/tools/vision/browserWorkbenchGating.test.ts \
  tests/renderer/utils/browserComputerActionPreview.test.ts \
  tests/renderer/components/browserComputerRedactionSurfaces.test.ts \
  tests/unit/agent/messageHistory.browserComputerRedaction.test.ts

npm run acceptance:browser-computer-workflow -- --provider system-chrome-cdp
npm run typecheck
```

## 11. 原新会话推进提示词（历史）

```text
你现在在 /Users/linchen/Downloads/ai/code-agent。

先按 AGENTS.md 做 Codex memory bootstrap，然后用 agent team 推进 Browser Use productization 的第一阶段。先读计划文档，不要凭印象：
- /Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-26-browser-use-production-roadmap.md
- /Users/linchen/Downloads/ai/code-agent/docs/acceptance/browser-computer-workbench-smoke.md
- /Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserService.ts
- /Users/linchen/Downloads/ai/code-agent/src/main/services/infra/browserProvider.ts
- /Users/linchen/Downloads/ai/code-agent/src/shared/contract/desktop.ts
- /Users/linchen/Downloads/ai/code-agent/src/main/ipc/desktop.ipc.ts
- /Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useWorkbenchBrowserSession.ts
- /Users/linchen/Downloads/ai/code-agent/src/main/tools/vision/browserAction.ts
- /Users/linchen/Downloads/ai/code-agent/src/shared/utils/browserComputerRedaction.ts

目标只做 Phase 1：BrowserSession + Profile 基线。

硬边界：
- 优先 in-app managed browser，不做远程浏览器池、不做外部 Chrome profile/CDP/extension bridge。
- 不做 storageState/cookie/localStorage/sessionStorage 导入导出，只为后续保留契约字段。
- 不做下载/上传。
- 不做大型重构；沿现有 browserAction / computer_use / browserService / desktop IPC 路径补强。
- 默认 provider 验收走 system Chrome headless + CDP。
- 不让 typed text、secret、cookie 进入日志、trace、replay、markdown export；如碰到 raw output，优先在源头修掉。
- 遇到 worktree 里已有无关改动，不要回滚。

建议 agent team：
- Explorer A：盘点 BrowserSession/Profile 相关现有类型、IPC、renderer 展示和测试，输出最小改动点。
- Explorer B：盘点 redaction 与 trace surfaces，确认新增 session/profile 字段不会泄露敏感路径或 typed text。
- Worker 1：实现 shared contract、browserService profile resolver、provider path 兼容。
- Worker 2：实现 IPC/renderer preview 和定向测试。
- Main agent：控制范围、整合 patch、跑测试和 acceptance smoke。

期望实现：
1. ManagedBrowserSessionState 增加 sessionId、profileId、profileMode、workspaceScope、artifactDir 等只读状态字段。
2. ensureManagedBrowserSession 支持 profileMode=persistent|isolated；默认保持 persistent 兼容现有 managed-browser-profile。
3. browserService 把固定 profileDir 抽成 resolver，isolated profile 使用临时目录并在 close 后安全清理，不误删 persistent profile。
4. browserProvider 继续支持 system-chrome-cdp 与 Playwright bundled，不改变默认优先级。
5. renderer 的 managed session preview 展示 profile/session 状态，但不要重做 UI。
6. 补最小测试：profile resolver、session state、renderer preview、现有 gating 不回退。

验收命令：
- npx vitest run tests/unit/services/infra/browserProvider.test.ts tests/unit/services/infra/browserServiceTraceRedaction.test.ts tests/unit/tools/vision/browserWorkbenchGating.test.ts tests/renderer/utils/browserComputerActionPreview.test.ts tests/renderer/components/browserComputerRedactionSurfaces.test.ts tests/unit/agent/messageHistory.browserComputerRedaction.test.ts
- npm run acceptance:browser-computer-workflow -- --provider system-chrome-cdp
- npm run typecheck

输出要求：
- 先给最小实施计划，再直接改。
- 每个关键结论带文件路径或测试证据。
- 最后说明改了哪些文件、哪些测试通过、哪些没跑或失败。
```
