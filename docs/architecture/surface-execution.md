# Surface Execution（Browser Use / Computer Use 执行运行时）

> 决策记录：[ADR-046](decisions/ADR-046-surface-execution-v1.md)。产品方案与逐条实施计划见
> `docs/plans/2026-07-20-surface-execution-browser-computer-use.md`，基线差距审计见
> `docs/audits/neo-surface-execution-v1-completion-audit.md`。本文描述合入 main（#529 / v0.28.0）后的实际架构。

Surface Execution 是 Browser 与 Computer 自动化共用的执行控制面：一套所有权模型、一套授权模型、一套观察-行动-验证合同、一条会话内的执行体验投影。它不替换既有 tool 名与消息格式，而是在其下方收口状态与信任边界。

## 分层总览

```text
Conversation 执行体验（renderer）
  SessionHeader · SemanticTimeline · EvidenceCard · Permission/Takeover/Recovery · Controls · PiP
                         │  单一状态源：surfaceExecutionStore
                         │  IPC domain:surfaceExecution（getSnapshot / getFrame / getOutput / control）
SurfaceConversationProjectionService（host 侧投影）
                         │
SurfaceExecutionRuntime + 服务群（owner-aware 控制面）
  Session · Grant · Observation · 可中止操作队列 · Event · Interrupt/Takeover · Proof · Output
             ┌───────────────┴────────────────┐
   Browser provider adapters          Computer adapter
   Managed（in-app CDP）              Stateful CUA（cuaStatefulComputerUse
   Relay（扩展协议 v2 + tab lease）      + cuaStateAdapter / cuaSessionLock）
   External（ExternalSurfaceAgentAdapter）
```

## 合同（`src/shared/contract/surfaceExecution.ts`）

| 概念 | 类型 | 要点 |
|---|---|---|
| 所有权 | `InteractiveSurfaceSessionV1` | owner 三元组 `sessionId + runId + agentId`（另带 conversationId）；一切读写按 owner 校验 |
| 目标 | `SurfaceTargetRefV1` | browser：instance/window/tab/frame + `documentRevision`；computer：device/app/pid/window + `windowRevision` |
| 授权 | `SurfaceAccessGrantV1` | subject + target + 能力档（observe/input/navigate/file/secret/destructive）+ dataScopes/actionClasses + 有效期/单次消费 |
| 观察 | `SurfaceObservationV1` / `SurfaceElementRefV1` | `stateId` + provider generation；element ref 绑定 backendNodeId（browser）或 axToken（computer）；生命周期 `fresh → consumed | superseded | expired`，写操作只认 `fresh` |
| 结果 | `SurfaceActionResultV1` | `delivery（confirmed/rejected/unknown）× verification（satisfied/…）→ overall`，附 successorState 观察 |
| 错误 | `SurfaceExecutionErrorV1` | 稳定错误码（传输/Session/所有权/Observation/策略/执行六类），固定携带 `phase · retryable · userActionRequired · recommendedAction · detailsSafe` |
| 证据 | `SurfaceEvidenceCardV1` | 检视三态 `captured → analyzed → verified`，截到图≠做对了 |
| 控制 | `SurfaceExecutionControlV1` | pause / resume / continue / takeover / skip / stop / end_session |

### 状态机

```text
Session:      preparing → waiting_permission → running ↔ waiting_human ↔ paused → stopping → completed | failed
Observation:  fresh → consumed | superseded | expired
Action:       queued → preflight → dispatching → verifying → succeeded | failed | ambiguous | cancelled
Takeover:     requested → human_control → resume_pending → running（或 cancelled | timed_out | navigated）
```

停止语义是硬边界：stop 之后旧 mutation 不得继续改页面/桌面，迟到的截图、引用与结果不得覆盖新一轮执行（stop 基准见 `docs/acceptance/surface-execution/stop-benchmark-current/`）。

## Host 运行时（`src/host/services/surfaceExecution/`）

| 服务 | 职责 |
|---|---|
| `SurfaceExecutionRuntime` | 工具层统一入口；组合下列服务，持有 `SurfaceCapabilityRegistry`（host 强制 capability preflight） |
| `SurfaceSessionManager` | owner 三元组 session 存续/心跳/过期 |
| `SurfaceAccessGrantService` | grant 签发、消费、撤销、过期 |
| `SurfaceOperationCoordinator` | 可中止操作队列（AbortSignal 贯通到 provider） |
| `SurfaceObservationRegistry` / `BrowserElementRefFence` | observation 生命周期与 element ref 越期拦截 |
| `SurfaceEventHub` | owner 校验的事件发布/订阅（renderer 投影的数据源） |
| `SurfaceInterruptService` / `SurfaceHumanTakeoverService` | pause/stop/end_session 与阻塞式人工接管（接管期间释放 provider 输入） |
| `SurfaceProofService` | proof 时间线（沿用 EvidenceRef 体系，重建完整执行/切换过程） |
| `SurfaceFrameRegistry` / `SurfaceOutputRegistry` | 帧（PiP/证据卡取图）与产出（artifact/file/download/trace）登记 |
| `SurfaceConversationControlService` / `SurfaceConversationProjectionService` | 会话侧控制入口与快照投影（IPC 消费方） |
| `SurfaceSwitchCoordinator` / `SurfaceContinuationService` | 跨 surface 切换（同 runId、父子会话、先收敛未完成 mutation）与断点续接 |
| `SurfaceOrganizationPolicyService` | 组织策略/审计存储（默认 in-memory store） |
| `SurfaceProviderRegistry` | provider 注册与可用性/目标边界裁决 |
| `BrowserTabLeaseService` | Relay tab 借还租约：记录原窗口/index/pinned/active，归还或恢复必达 |
| `BrowserProfileImportApprovalService` | Cookie/profile 导入的 Host 签发 approval（绑定 source/target profile、domain allowlist、有效期） |

Provider adapters：`ManagedBrowserProviderAdapter`（in-app CDP）、`RelayBrowserProviderAdapter`（扩展协议 v2）、`ExternalSurfaceAgentAdapter`（外部 agent 入口，P2 预留）；Computer 侧由 Stateful CUA（`src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.ts` + `src/host/mcp/cuaStateAdapter.ts` / `cuaSessionLock.ts`）适配，保留 state-bound mutation 与 delivery/verification 拆分。工具层的 `browserEngineRouter` 按 capability/所有权/目标裁决 auto/managed/relay，不再以"有附着 tab"单因子选 Relay。

## Relay 协议 v2（扩展信任边界）

wire 目录：`resources/browser-relay-extension/protocol-v2.js`（`protocolVersion: 2.x`），与 `src/shared/contract/browserRelay.ts` 同源对账。要点：

- capability 握手声明 lease/tab/dom/ax/network/dialog/file/input 能力集；版本不匹配走 `SURFACE_PROTOCOL_VERSION_MISMATCH`。
- tab 附着必须走 `lease.request → 用户批准 → lease.return` 租约，杜绝枚举全部 tab / 任意 `tabId` attach；Agent Window 隔离代理操作窗口。
- 输入走真实输入方法（`input.click/type/key/scroll/hover/drag`），不再用 JS click / 直接赋值。
- `operation.cancel` 使超时可以真正撤销已派发的 mutation；dialog（alert/confirm/prompt/beforeunload）默认暂停待批。
- Host 与扩展两侧均校验 owner/grant/domain/action/expiry；审批消息由 `browserRelayApprovalBoundary`（`validateBrowserRelayLeaseApproval`）做协议/时间窗/scope 子集/placement 完整校验，approval 不得扩大待批范围。

## 会话执行体验（renderer）

链路：`SurfaceEventHub` → `SurfaceConversationProjectionService` → IPC `domain:surfaceExecution`（action：`getSnapshot` / `getFrame` / `getOutput` / `control`，control intent 为 pause/resume/continue/takeover/stop/end_session）→ `surfaceExecutionClient` / `surfaceExecutionController` → `surfaceExecutionStore`（Zustand 单一状态源）。

组件在 `src/renderer/components/features/surfaceExecution/`：ConversationPanel / ChatPanel / ExecutionCard / SessionHeader / SemanticTimeline / EvidenceCard+List / PermissionCard / InterventionCards（Takeover+Recovery）/ Controls / RunStatus / OutputEntry / ResourceSections。Sidebar、会话、composer、PiP 消费同一投影，折叠 turn 保留关键证据与产出（配合 ADR-043 三态折叠）。PiP 由 `useSurfaceExecutionPip` + `public/pip.html` 承载，控制事件走白名单校验；`useComputerUsePip` 仅为兼容转发。文案经 `src/renderer/i18n/surfaceExecution.ts` 的 `getSurfaceExecutionTranslations` 提供中英双语。

## 安全与脱敏

- `src/shared/utils/surfaceExecutionRedaction.ts`：敏感键位（authorization/token/cookie/clipboard/password/…）、内联凭证、canary 标记、绝对路径全链脱敏；console/network 默认只留脱敏 metadata。
- 导出边界：`surfaceExecutionExportProjection` / `ExportFieldSanitizer` / `ExportCaptureContext` 保证 proof、diagnostic bundle、session export 不携带明文敏感值（红线用例见 `tests/unit/shared/browserComputerRedaction.*`、`surfaceExecutionExport*`）。
- 授权展示合同：Permission Card 必须呈现目标、能力档、数据去向、有效期与拒绝影响；默认"允许一次/本次任务/拒绝"，高风险能力不提供无边界 Always。
- 登录、MFA、CAPTCHA、支付与账号安全路径不做自动化，固定走 manual takeover / unsupported 分流。

## 验收与发版证据

- 验收 harness：`scripts/acceptance/surface-execution-*.ts`（conversation / computer / cross-surface / managed / relay / controlled-complex / durable-restart / stop-benchmark / workbuddy / canary-scan / gate-report），proof 落盘 `docs/acceptance/surface-execution/`。
- 协议红线（未授权读写拒绝、跨 agent/session 隔离、越期 ref、post-stop mutation）在真机 dogfood 前先行；`surface-execution-gate-report` 汇总门状态。
- 发版侧：release CI 的稳定性证据门（`check:provider-runtime-release-evidence --mode full`）要求 long-session 金样、tool-cancel 冒烟、agent-runtime app-host 冒烟相对本链路代码保持新鲜（2026-07-21 v0.28.0 首个 tag 即因证据过期被拦，重铸后放行）。

## 边界与 backlog

- External `neo surface` / `neo browser` 外部 adapter、组织级策略面/审计保留、Windows/Linux Surface provider、多浏览器/远程池/移动端仍属 P2（决策门要求 P0/P1 真实使用数据）。
- Computer 的 background AX / CGEvent 仅对显式 target app/window 与受控 smoke 成立，foreground fallback 仍需人工确认。
- Agent Pointer 是 app 内可视化，不声明系统鼠标所有权。
- Relay 依赖用户侧扩展安装与配对；签名分发/升级兼容的运行时证明仍在补强。
