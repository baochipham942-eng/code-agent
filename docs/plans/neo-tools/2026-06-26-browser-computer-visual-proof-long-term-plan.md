# Browser / Computer Use / Visual Proof 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇归 **WP-D**，推荐优先级 **6（最贴 cowork 产物轴）**。要点：
> - `BrowserComputerProofBundle` 改为"一组统一 `EvidenceRef`（dom/a11y/screenshot/ax）+ 少量领域字段（targetRef/approval/manualTakeover）"，不再是独立大对象（见 WP-A）。
> - 产品红线保留且正确："只有截图 path 不算看到 UI"、"登录/MFA/CAPTCHA 不自动绕过"。
> - **remote browser provider / external Chrome attach / video timeline 维持 P2 之后**（账号态与数据隔离风险）。
> 下文 P0/P1/P2 保留作 depth 参考，**实际开工以集成文档 WP-D 为准**。

## 判断

Neo 的工具路线应该以 Browser 为网页主路径，以 Computer Use 为原生桌面和不可结构化 UI 的补位路径，以 Visual Proof 作为跨路径的验收层。

网页任务的可信证据优先级是 DOM / Accessibility / console / network / account summary / artifact summary，截图用于视觉确认和人类复盘。桌面任务的可信证据优先级是 app/window 身份、AX 树或窗口引用、before/after observe、审批与安全状态、截图分析结果。视频适合长流程审阅，但不能替代结构化证据。

当前 Neo 已经有不少底座对象，但证据还散在 tool result、metadata、trace、screenshot path、recovery outcome 和 renderer 卡片里。下一阶段最重要的产品化动作，是把这些能力合成一个统一、可导出、可复盘、可做失败恢复的 Browser/Computer proof layer。

## 目标形态

1. Browser 任务默认走 managed browser。
   - 本地开发、未登录页面、可控 fixture、自动化表单、下载上传、DOM/a11y 验收，都走 managed browser。
   - DOM/a11y/TargetRef 是动作 grounding，截图是补充证据。
   - 每个 mutating action 后必须有新的 DOM/a11y 或 analyzed screenshot 证据，才能声明 UI 状态完成。

2. Computer Use 只承担需要真实桌面的任务。
   - 原生 App、系统设置、用户真实 Chrome 登录态、MFA、不可通过 DOM 表达的 UI，才进入 Computer Surface / CUA。
   - 优先 AX 树和窗口引用，坐标点击只作为最后 fallback。
   - 前台 fallback 必须明确告诉用户会作用于当前窗口，并要求动作后重新 observe。

3. Visual Proof 是统一证据层。
   - 每次关键动作生成 `BrowserComputerProofBundle`，把结构化状态、视觉证据、审批、安全、失败恢复绑在一起。
   - 证据卡面向用户展示“我基于什么判断完成”，而不是只展示工具 JSON。
   - 文件导出、session replay、review queue、benchmark 都使用同一份 proof bundle。

4. 人工接管是一等路径。
   - 登录、MFA、CAPTCHA、风控、付款、权限弹窗、账号安全设置，不做自动绕过。
   - 用户接管后，Neo 重新抓取 DOM/a11y/screenshot/account summary，恢复到可审计自动化。

## Neo 当前状态

Browser 侧已经有本地受控生产化基线：

- `docs/plans/2026-04-26-browser-use-production-roadmap.md`
  - Phase 1-6 已落地：BrowserSession/Profile、TargetRef、AccountState、download/upload、lease/proxy、browser task benchmark。
  - external / remote browser、外部 Chrome profile、extension bridge 仍是明确未交付边界。
- `src/main/services/infra/browser/types.ts`
  - `BrowserTargetRef` 已有 `refId`、`selector`、`tabId`、`snapshotId`、`ttlMs`、`confidence`。
- `src/main/services/infra/browser/domSnapshotBuilder.ts`
  - DOM snapshot 能生成 headings、interactive elements 和 targetRef。
- `src/main/tools/vision/browserAction.ts`
  - 支持 launch、navigate、click/type targetRef、DOM/a11y snapshot、account summary、storageState import/export、download/upload、screenshot。
  - stale TargetRef 有 recoverable metadata 和 refresh hint。
- `src/main/services/infra/browser/browserTraceLifecycle.ts`
  - trace 有 before/after、params 脱敏、console/network failure、screenshotPath，但目前主要是进程内 recent trace。

Computer Use 侧已经有安全执行骨架：

- `src/main/tools/vision/computerUse.ts`
  - 工具说明要求先 observe/get_state/get_windows/get_ax_elements，动作后再 observe/get_state。
  - 支持 background AX、background CGEvent、foreground fallback、batch、窗口诊断和前台输入 warning。
- `src/main/services/desktop/computerSurface.ts`
  - 有 app approval、敏感动作强确认、受保护 App 黑名单、前台 fallback 校验、after observe。
- `src/main/services/desktop/computerSurfaceLock.ts`
  - 写动作 FIFO 串行，read action 不进锁。
- `src/main/services/desktop/computerSurfaceEvidence.ts`
  - 能生成 before/after app/window、AX locator、CGEvent window、window local point 等 evidence summary。
- `docs/proposals/computer-use-cua-migration.md`
  - 明确桌面 App 走 CUA / AX-first，浏览器继续走 Playwright browser_action。
  - 已有 CUA driver 打包、权限 UI、人话文案等进度，但完整装机和真机多步 GUI 闭环仍待验证。

Visual Proof 侧已有局部规则，但尚未合流：

- `src/main/tools/vision/screenshot.ts`
  - 已明确只有截图路径不能声称看到了 UI，必须 `analyze=true` 或后续图像分析。
  - analyze 失败会返回 `cannotObserveScreen`，避免假验收。
- `src/shared/utils/browserComputerRedaction.ts`
  - 已覆盖 typed text、formData、secretRef、cookie/storage、raw DOM/AX/html、base64、raw local path 等脱敏。
- `docs/acceptance/browser-computer-workbench-smoke.md`
  - 验收已覆盖 System Chrome CDP、DOM snapshot、a11y、TargetRef recovery、account/profile/artifact、Background AX/CGEvent、UI redaction、read-only recovery action。

## 长期路线

### P0

P0 目标是把已有证据合成可用产品闭环，不扩展 remote browser，不读取外部 Chrome cookies，不做视频主链路。

1. `BrowserComputerProofBundle`
   - 新增统一 proof 数据结构。
   - 字段至少包含：
     - `proofId`
     - `traceId`
     - `targetKind` = `browser | computer`
     - `toolName`
     - `action`
     - `startedAtMs` / `completedAtMs`
     - `success`
     - `before`
     - `after`
     - `domSnapshotRef`
     - `accessibilitySummary`
     - `targetRef`
     - `screenshot`
     - `visionAnalysis`
     - `consoleSummary`
     - `networkSummary`
     - `accountState`
     - `artifact`
     - `permission`
     - `manualTakeover`
     - `failureKind`
     - `recovery`
     - `redactionStatus`
   - Browser proof 从 `WorkbenchActionTrace`、DOM snapshot、a11y snapshot、screenshot result、account/artifact summary 合成。
   - Computer proof 从 `WorkbenchActionTrace`、ComputerSurface state、observe snapshot、AX/CGEvent metadata、screenshot analysis 合成。

2. 统一证据卡
   - 在工具详情里新增 Browser/Computer 统一证据卡。
   - 卡片分区：
     - 目标：URL/tab 或 app/window。
     - 动作：tool/action/targetRef/locator。
     - 结构化证据：DOM headings、interactive count、a11y available、AX candidate、windowRef。
     - 视觉证据：screenshot path、analyzed status、cannotObserveScreen。
     - 安全状态：approval scope、foreground fallback、sensitive action、redaction status。
     - 恢复动作：refresh snapshot、observe window、list AX candidates、manual takeover。
   - 恢复按钮只做 read-only 证据准备，不自动重试原动作。

3. 截图 analyzed 规则
   - 统一规则：只有 path 的截图是 artifact，不是 observation。
   - `screenshot.analyzed === true` 或明确的 DOM/a11y 状态，才能参与“视觉验收通过”。
   - analyze 失败时 proof 标记 `visualProofStatus=unavailable`，并保留 `cannotObserveScreen`。
   - browser screenshot、desktop screenshot、ComputerSurface observe screenshot 使用同一套状态字段。

4. manual takeover 和登录/MFA 状态
   - 新增恢复状态：
     - `login_required`
     - `mfa_required`
     - `captcha_or_risk_control`
     - `manual_takeover_required`
     - `permission_prompt_required`
     - `account_state_expired`
   - Browser 遇到登录页、过期 cookie、MFA 输入、CAPTCHA-like fixture、支付/账号安全路径时，不自动继续。
   - 用户接管后提供 `resume_after_takeover`：
     - 刷新 DOM/a11y。
     - 刷新 account summary。
     - 重新生成 proof bundle。
     - 只在可验证状态恢复后继续自动化。

5. 当前 benchmark 升级
   - 在现有 browser task benchmark 增加 proof bundle snapshot。
   - 每个 BT case 验证 proof bundle 不含 secret、cookie value、raw base64、raw storage path。
   - 增加 login/MFA/manual takeover fixture，不解 CAPTCHA，只验证分类和恢复入口。

### P1

P1 目标是把 proof 从“当次工具结果”升级成 durable evidence。

1. durable trace store
   - 把当前进程内 recent trace 升级成持久化 store。
   - 保存 sanitized proof bundle、trace index、artifact refs、recovery attempts。
   - 支持按 session、tool、targetKind、failureKind、URL/app 检索。
   - session export、markdown export、review queue、replay 使用同一持久化证据源。

2. profile/account 管理面
   - UI 显示 browser session、profile mode、workspace scope、account summary、expired state。
   - 支持创建 isolated session、清理 isolated profile、导入/导出 storageState 的安全确认。
   - 默认不展示 raw cookie/storage value，只展示 domain/origin/count/expired summary。

3. proof-aware recovery plan
   - 把恢复从单个 hint 扩成可执行 plan：
     - `refresh_dom_a11y`
     - `resolve_target_ref`
     - `observe_visual`
     - `list_ax_candidates`
     - `manual_takeover`
     - `stop_unrecoverable`
   - 每一步产生新的 proof bundle 或 proof event。
   - 自动重试只允许在本地 fixture、低风险、同 origin、同 targetRef freshness 条件满足时启用。

4. CUA AX-first 合流
   - 将 CUA driver 的 AX-first 输出接入 proof bundle。
   - 每个桌面动作执行 `snapshot -> action -> snapshot`。
   - 检测 silent-drop：动作前后 AX/visual 状态无变化时标记 `action_may_not_have_effect`。
   - CUA、ComputerSurface background AX、background CGEvent 的证据字段合流，不引入第二套 UI 语言。

5. browser log / network 证据摘要
   - console/network 不直接塞大段文本进模型上下文。
   - trace 里保存摘要和文件引用，Agent 可按需 grep/read 相关行。
   - 对齐 Cursor 的低 token 日志处理思路。

### P2

P2 目标是支持更真实、更长的产品工作流，但仍守住安全边界。

1. Chrome extension / external browser 只读 attach
   - 只在用户显式授权后使用真实 Chrome 登录态。
   - 初期只做 read-only inspection、manual takeover 后 resume，不做外部 cookies 自动导出。
   - proof bundle 标记 `externalBrowser=true`、`authorizationScope`、`profileAccess=none|summary|readOnlyAttach`。

2. long-run visual timeline
   - 为长流程生成 screenshot timeline 或 video reference。
   - video/timeline 用于人类审阅和 replay，不作为唯一 agent grounding。
   - 每个关键帧关联 proof bundle 和 traceId。

3. multi-session Browser manager
   - 多 context、多 profile、多任务隔离。
   - lease、TTL、artifactDir、proxy、account state 都挂在 session 上。
   - 验证 cookie/localStorage/trace/artifact 不串。

4. policy-aware browser automation
   - 引入 origin allowlist / blocklist 的产品 UI。
   - 手动导航越界后，工具动作阻止并显示原因。
   - allowlist 边界按 best-effort 表达，不承诺阻止所有 redirect/client navigation。

5. production visual regression
   - 针对前端 app 增加 proof-driven visual regression。
   - 结构化断言优先，截图 diff 辅助。
   - 失败输出统一进入 proof bundle 和 review queue。

### Later

1. remote browser provider
   - Browserbase / 自建 browser service / 云端 browser pool 作为 provider registry。
   - 需要 health、lease、recycle、cost、proxy、artifact 和 proof 合流。
   - 不进入 P0/P1。

2. workflow / recipe productization
   - 成功 trace 生成 recipe。
   - recipe 必须绑定 allowed origins、参数 schema、fresh TargetRef 策略、proof expectation。
   - 只从 fixture-only 和低风险真实站点开始。

3. locked / unattended desktop work
   - 需要更强权限模型、用户可见状态、远程接管和终止机制。
   - 只有 Computer Use helper、权限、proof、recovery 都成熟后再做。

## 关键实现区域

Browser 主路径：

- `src/main/tools/vision/browserAction.ts`
- `src/main/tools/vision/BrowserTool.ts`
- `src/main/tools/vision/browserWorkbenchIntent.ts`
- `src/main/services/infra/browserService.ts`
- `src/main/services/infra/browser/types.ts`
- `src/main/services/infra/browser/domSnapshotBuilder.ts`
- `src/main/services/infra/browser/targetRefRegistry.ts`
- `src/main/services/infra/browser/browserTraceLifecycle.ts`
- `src/main/services/infra/browser/browserSessionState.ts`
- `src/main/services/infra/browser/browserArtifactActions.ts`
- `src/main/services/infra/browser/accountStateHelpers.ts`
- `src/main/services/infra/browser/managedBrowserHelpers.ts`

Computer Surface / CUA 合流：

- `src/main/tools/vision/computerUse.ts`
- `src/main/tools/vision/computerUseSurfaceRuntime.ts`
- `src/main/tools/vision/computerUseSmartBrowserActions.ts`
- `src/main/services/desktop/computerSurface.ts`
- `src/main/services/desktop/computerSurfaceEvidence.ts`
- `src/main/services/desktop/computerSurfaceSafety.ts`
- `src/main/services/desktop/computerSurfaceScreenshots.ts`
- `src/main/services/desktop/computerSurfaceLock.ts`
- `src/main/services/desktop/backgroundAxBridge.ts`
- `src/main/services/desktop/backgroundCgEventBridge.ts`
- `src/main/mcp/mcpDefaultServers.ts`

视觉证据与脱敏：

- `src/main/tools/vision/screenshot.ts`
- `src/main/services/desktop/visionAnalysisService.ts`
- `src/shared/utils/browserComputerRedaction.ts`
- `src/main/tools/vision/coordinateTransform.ts`

Renderer / 证据卡 / recovery：

- `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails.tsx`
- `src/renderer/utils/browserComputerActionPreview.ts`
- `src/renderer/utils/toolStepGrouping.ts`
- `src/renderer/hooks/useWorkbenchBrowserSession.ts`
- `src/shared/contract/desktop.ts`

验收与测试：

- `docs/acceptance/browser-computer-workbench-smoke.md`
- `scripts/acceptance/browser-computer-suite.ts`
- `scripts/acceptance/browser-computer-workflow-smoke.ts`
- `scripts/acceptance/browser-task-benchmark.ts`
- `tests/unit/tools/vision/browserWorkbenchGating.test.ts`
- `tests/unit/tools/vision/computerSurfaceGating.test.ts`
- `tests/unit/tools/vision/screenshotAnalysisFailure.test.ts`
- `tests/unit/agent/messageHistory.browserComputerRedaction.test.ts`
- `tests/unit/session/exportMarkdown.browserComputer.test.ts`
- `tests/renderer/components/toolDetailsComputerRecovery.test.ts`

## 验收标准

P0 验收：

- Browser action 成功后返回 proof bundle，包含 traceId、before/after、targetRef 或 selector、DOM/a11y summary、screenshot analyzed 状态、account/artifact summary。
- Computer action 成功后返回 proof bundle，包含 app/window before/after、surface mode、approval scope、locator 类型、evidence summary、reobserveRequired。
- 只有 screenshot path 且未 analyze 时，UI 和导出不能表达为“已视觉确认”。
- screenshot analyze 失败时，proof 标记 `cannotObserveScreen`，工具结果不能被当作视觉验收成功。
- stale TargetRef 失败时，证据卡显示 refresh DOM/a11y 的 read-only recovery，不自动点击。
- desktop failure 时，证据卡只提供 get_state、observe、list AX candidates、manual takeover，不自动重试 type/click。
- 登录过期、MFA、CAPTCHA-like fixture 被分类为 manual takeover，不尝试自动绕过。
- sanitized export 不包含 typed secret、cookie value、storageState raw value、screenshot base64、raw local paths。
- `npm run acceptance:browser-computer-all` 的既有覆盖不回退。

P1 验收：

- proof bundle 可持久化，可按 session/replay/review queue 读取。
- markdown/json export 使用 durable sanitized proof，不回读 raw metadata。
- Profile/account UI 能展示 persistent/isolated、workspace scope、cookie/origin/count/expired summary。
- CUA AX-first 动作生成与 ComputerSurface 一致的 before/action/after proof。
- silent-drop 能被标记为 warning，并给出 refresh AX/observe/retry 或 manual takeover。

P2 验收：

- external browser attach 只在显式授权下启用，默认不读取 raw cookies。
- browser policy 能阻止未授权 origin 上的工具动作，并说明 manual navigation 与 tool restriction 的区别。
- 多 browser session 并行时 cookie/localStorage/trace/artifact 不串。
- video/timeline 每个关键帧可回指 proof bundle，不作为唯一验收依据。

## 风险与未决问题

- 视觉模型失败不能被静默降级成“已观察”。已有 screenshot 规则要推广到 browser screenshot 和 ComputerSurface observe。
- DOM/a11y 与截图可能冲突。产品上应优先结构化状态，截图用于解释视觉差异；冲突时标记 `proof_conflict`，要求复查。
- TargetRef 不应被包装成跨页面长期稳定引用。TTL、snapshotId、tabId、URL 约束必须继续保留。
- 登录态和 MFA 的边界必须清楚。Neo 可以帮用户恢复和验证状态，不能自动绕过网站安全机制。
- CUA 与现有 ComputerSurface 不能形成两套互相竞争的运行时 fallback。浏览器仍走 BrowserService；桌面走 AX-first / CUA / ComputerSurface。
- durable trace store 会引入敏感数据持久化风险，必须先做 schema 级脱敏和导出测试。
- remote browser provider、外部 Chrome profile、extension bridge 都有账号态和数据隔离风险，不能提前塞进 P0。
- 视频证据成本高、隐私风险高、token 效率低，只适合审阅和 replay，不适合当 agent 主 grounding。

## 证据来源

本地证据：

- `docs/acceptance/browser-computer-workbench-smoke.md`
- `docs/plans/2026-04-26-browser-use-production-roadmap.md`
- `docs/proposals/computer-use-cua-migration.md`
- `src/main/tools/vision/browserAction.ts`
- `src/main/tools/vision/BrowserTool.ts`
- `src/main/tools/vision/computerUse.ts`
- `src/main/tools/vision/screenshot.ts`
- `src/main/services/infra/browserService.ts`
- `src/main/services/infra/browser/types.ts`
- `src/main/services/infra/browser/domSnapshotBuilder.ts`
- `src/main/services/infra/browser/targetRefRegistry.ts`
- `src/main/services/infra/browser/browserTraceLifecycle.ts`
- `src/main/services/desktop/computerSurface.ts`
- `src/main/services/desktop/computerSurfaceEvidence.ts`
- `src/main/services/desktop/computerSurfaceSafety.ts`
- `src/main/services/desktop/computerSurfaceLock.ts`
- `src/shared/utils/browserComputerRedaction.ts`
- `tests/unit/tools/vision/browserWorkbenchGating.test.ts`
- `tests/unit/tools/vision/computerSurfaceGating.test.ts`
- `tests/unit/tools/vision/screenshotAnalysisFailure.test.ts`
- `tests/renderer/components/toolDetailsComputerRecovery.test.ts`
- `scripts/acceptance/browser-task-benchmark.ts`

外部官方证据：

- Cursor Browser docs: `https://cursor.com/docs/agent/tools/browser.md`
- OpenAI Codex manual: `https://developers.openai.com/codex/codex-manual.md`

本方案只使用本线程已经读到的证据收口。Devin、Replit、Anthropic 相关页面本轮没有形成可引用正文，后续若要进入对标表，需要单独补官方资料核验。
