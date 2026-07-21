# Neo Surface Execution V1：Browser Use、Computer Use 与会话执行体验完整方案

> 日期：2026-07-20  
> 状态：Proposed，implementation-ready  
> Neo 基线：`origin/main@ec7b06cfaaa4a3ed4f4928c02949121070d3e69f`  
> 对标基线：`Tencent/BrowserSkill@ccf3c321402995461dc54d7c3ed91f49da519b90`  
> 关联决策：`ADR-037`、`ADR-041`、`ADR-043`  
> 关联验收：`docs/acceptance/browser-login-reuse-parity.md`  
> 研究截图：`Screenshot 2026-07-20 at 23.38.20.png`，WorkBuddy v5.2.6 会话执行体验

## 1. 产品判断

Neo 已经具备 Browser Use 与 Computer Use 的大部分能力零件，包括 Managed/Relay 双浏览器引擎、隔离 profile、Cookie 导入、上传下载、DOM/AX/截图观察、Computer Surface、Stateful CUA、proof、redaction、recovery、pointer、artifact 和会话工具展示。

当前差距集中在三个层面：

1. Browser 与 Computer 的共享能力主要停留在展示和记录层，还没有成为 Host、provider、扩展共同强制执行的运行时合同。
2. Relay 的 tab 授权、会话所有权、元素引用、取消和人机接管不够可信；部分契约声明与实际运行行为不一致。
3. 会话中展示的仍以 tool log 为主。截图、观察、判断、验证和下一步没有被组织成用户能读懂、可干预、可回放的执行过程。

本方案把原先的 Browser V2 上移为 `Surface Execution V1`，并在其下保留 Browser 与 Computer 两个 provider adapter。目标产品定义为：

> Neo 是一个会话式、可接管、可验证的交互执行工作台。用户始终知道 Neo 正在操作什么、依据什么证据继续、是否需要人工介入，以及最终由什么证明任务完成。

## 2. 目标与非目标

### 2.1 目标

- Browser Use 与 Computer Use 共用 Session、Grant、Observation、Action Result、Evidence、Interrupt、Human Takeover 和会话时间线。
- Browser 保持 tab/domain/profile/navigation 等专属边界；Computer 保持 app/window/TCC/focus/input lock 等专属边界。
- Managed Browser 默认承担隔离、可复现任务；真实 Chrome 只在用户明确选择登录态复用时限时授权。
- 所有关键 mutation 区分动作已发送、结果已观察、目标已验证。
- 所有截图区分已截取、已读取、已验证，禁止仅拿到文件路径就声称观察过页面。
- 会话、侧栏、Composer、Dock/PiP 由同一 Run 状态机驱动。
- 用户能暂停、接管、停止当前任务或结束整个 Surface Session。
- proof、日志、截图、导出和诊断包保持 fail-closed redaction。
- P0、P1、P2 都必须有自动化与真实运行证据；实现会话不得完成 P0 后提前结束整个 Goal。

### 2.2 非目标

- P0 不新增远程浏览器池、移动端、Firefox 或 Safari。
- P0 不重写整个 Agent Engine、RunRegistry、消息存储或通用权限系统。
- 不把 `browser_action` 和 `computer_use` 压成一个平坦、巨大的动作 schema。
- 不展示模型原始思维链。会话只展示计划摘要、观察事实、判断依据、下一步和用户需要知道的风险。
- 不让 Agent 静默挂载用户日常 Chromium `user-data-dir`。
- 不绕过 MFA、CAPTCHA、支付确认、浏览器安全警告或网站反自动化策略。
- 未获得新授权时不 push、不发布、不部署、不写生产数据、不提交商店扩展。

## 3. 对标结论

### 3.1 BrowserSkill 值得吸收的能力

- 每个 session 有明确 Agent Window 和控制归属。
- 用户 tab 通过申请、批准、借用、使用、归还的租约流程进入 Agent Window。
- AX snapshot 的临时 ref 绑定 session、tab 和 backend DOM node。
- `request-help` 是阻塞式协议能力，支持继续、取消、超时和导航结果。
- 页面内持续显示 Agent 控制状态与 Interrupt。
- Session stop 优先恢复用户 tab，归还失败时保留现场供恢复。
- daemon、扩展与协议具备版本握手、稳定错误与 doctor 思路。

### 3.2 BrowserSkill 不直接复制的部分

- Agent Window 仍共享用户完整浏览器 profile，不构成凭据隔离。
- 只读观察路径的 tab 权限检查与其隐私文案并不完全一致。
- 敏感动作主要依靠 Skill 文本约束，缺少 Neo 现有 proof、redaction、domain policy 和审批账本。
- 浏览器 dialog 自动接受不适合支付、删除、授权等高风险场景。
- 工具面与 artifact 能力弱于 Neo，缺少完整上传下载、storage state、Cookie 导入和 Computer Use。
- 现有 CI 没有证明真实登录网站端到端成功率领先。

### 3.3 WorkBuddy 值得吸收的能力

- 任务级运行状态持续存在，侧栏、会话和输入区都有可感知的运行信号。
- 已有结果与后续执行同时存在，长任务不会因为新 spinner 覆盖历史结果。
- 产物在会话内有稳定入口。
- 当前步骤可以局部跳过，整个 Run 可以全局停止。
- 视觉检查进入任务叙事：生成、截图、观察、判断、调整、复验。
- 用户能够在过程中判断结果并介入验收。

Neo 应进一步把自然语言的“截图符合预期”绑定到真实 Evidence Card、检查项与 verdict，形成可验证执行账本。

## 4. 目标用户旅程

### 4.1 标准流程

```text
输入任务
  → 选择 Surface 目标
  → 展示权限与数据范围
  → 启动 Surface Session
  → 操作与观察
  → 必要时用户接管
  → 结果验证
  → 展示产物与证据
  → 归还 tab / 释放输入锁 / 关闭会话
```

### 4.2 Browser 选择

Composer 常驻 Browser Chip，对普通用户只显示：

- 自动选择
- Neo 隔离浏览器
- 我的 Chrome 标签页

选择后显示真实目标，例如 `GitHub Issues · 我的 Chrome`，不把 Relay、CDP、provider 等工程术语作为主界面概念。

### 4.3 首次设置

缺少浏览器环境时，在当前会话展开 Setup Card：

1. 启动 Neo 隔离浏览器，或安装/连接 Chrome 扩展。
2. 检查扩展、Host 和协议版本。
3. 用户从扩展侧选择要借用的 tab。
4. 回到当前任务继续执行。

用户无需离开任务进入 Settings 和全屏高级工具才能完成基础设置。

### 4.4 人工接管

验证码、OTP、支付确认、模糊选择或策略阻断时：

1. Session 进入 `waiting_human`。
2. 页面或窗口突出显示需要处理的位置。
3. Neo 释放对应输入控制，不继续发 mutation。
4. 用户完成后点击继续。
5. Neo 重新观察并生成新 state，旧 ref 全部失效。
6. 任务从新证据继续。

## 5. 总体架构

```text
Conversation Surface Execution
  Session Header · Semantic Timeline · Evidence Card · Controls · Outputs
                              │
                    Surface Event Projector
                              │
                    Surface Execution V1
  Session · Target · Grant · Observation · Action · Verification · Handoff
             ┌────────────────┴────────────────┐
      Browser Provider Adapters         Computer Provider Adapters
   Managed · Relay · future remote     CUA · AX · CGEvent · foreground
             │                                  │
   browser extension / CDP             macOS accessibility / input runtime
```

### 5.1 推荐模块边界

```text
src/shared/contract/surfaceExecution.ts
src/shared/utils/surfaceExecutionRedaction.ts

src/host/services/surfaceExecution/
  SurfaceSessionManager
  SurfaceCapabilityRegistry
  SurfaceAccessGrantService
  SurfaceActionOrchestrator
  SurfaceObservationRegistry
  SurfaceEventHub
  SurfaceInterruptService
  SurfaceHumanTakeoverService
  SurfaceProofService
  SurfaceRecoveryClassifier

src/host/services/infra/browser/
  ManagedBrowserProviderAdapter
  RelayBrowserProviderAdapter
  BrowserTabLeaseService
  BrowserElementRefRegistry

src/host/services/desktop/
  ComputerSurfaceProviderAdapter
  ComputerInputLockService

src/renderer/components/features/surfaceExecution/
  SurfaceExecutionCard
  SurfaceSessionHeader
  SurfaceSemanticTimeline
  SurfaceEvidenceCard
  SurfacePermissionCard
  SurfaceHumanTakeoverCard
  SurfaceControls
```

现有 `relayActionFacade` 收敛为 provider adapter，不继续承载跨引擎产品合同。现有 `browserComputerActionCatalog` 逐步升级为 Host 强制执行的 capability registry，不能只供 Renderer 摘要和 recovery 使用。

## 6. Surface Execution V1 合同

### 6.1 Session

```ts
type SurfaceKind = 'browser' | 'computer';

interface InteractiveSurfaceSessionV1 {
  version: 1;
  sessionId: string;
  runId: string;
  taskId?: string;
  turnId?: string;
  conversationId: string;
  agentId: string;
  surface: SurfaceKind;
  provider: string;
  capabilities: SurfaceCapabilityManifestV1;
  state:
    | 'preparing'
    | 'waiting_permission'
    | 'running'
    | 'waiting_human'
    | 'paused'
    | 'stopping'
    | 'completed'
    | 'failed';
  activeTarget?: SurfaceTargetRefV1;
  grantId?: string;
  startedAt: number;
  heartbeatAt: number;
  expiresAt?: number;
}
```

所有 Host、Renderer、扩展事件必须携带 `sessionId + runId + agentId`。旧事件没有明确 owner 时只能进入兼容投影，不得驱动新的写操作。

### 6.2 Target

```ts
type SurfaceTargetRefV1 =
  | {
      kind: 'browser';
      browserInstanceId: string;
      windowRef: string;
      tabRef: string;
      frameRef?: string;
      origin?: string;
      documentRevision: string;
      title?: string;
    }
  | {
      kind: 'computer';
      deviceId: string;
      appName: string;
      bundleId?: string;
      pid: number;
      windowRef: string;
      spaceId?: string;
      windowRevision: string;
      title?: string;
    };
```

Browser tab id、Chrome debugger id、PID、macOS window id 等原生标识不直接作为 Agent 可自由构造的授权凭证。Agent 使用 Host 签发的 opaque ref。

### 6.3 Grant

```ts
interface SurfaceAccessGrantV1 {
  version: 1;
  grantId: string;
  subject: { sessionId: string; runId: string; agentId: string };
  target: SurfaceTargetRefV1;
  capabilities: ('observe' | 'input' | 'navigate' | 'file' | 'secret' | 'destructive')[];
  dataScopes: string[];
  actionClasses: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  singleUse?: boolean;
  consumedAt?: number;
}
```

Browser grant 运行时落成 tab/domain lease；Computer grant 落成 app/window approval 与全局输入锁。权限校验必须发生在 Host 和 provider/扩展边界，Renderer 与 prompt 只负责解释。

### 6.4 Observation 与 Element Ref

```ts
interface SurfaceObservationV1 {
  version: 1;
  stateId: string;
  target: SurfaceTargetRefV1;
  providerGeneration: string;
  observedAt: number;
  expiresAt: number;
  elementRefs: SurfaceElementRefV1[];
  evidenceAssetIds: string[];
  redactionStatus: 'clean' | 'redacted' | 'blocked';
  consumedAt?: number;
}

type SurfaceElementRefV1 =
  | {
      kind: 'browser-element';
      ref: string;
      stateId: string;
      tabRef: string;
      frameRef?: string;
      documentRevision: string;
      backendNodeId: number;
      role?: string;
      name?: string;
      bounds?: Rect;
      selectorFallback?: string;
    }
  | {
      kind: 'computer-element';
      ref: string;
      stateId: string;
      windowRef: string;
      windowRevision: string;
      axToken?: string;
      role?: string;
      label?: string;
      bounds?: Rect;
      screenshotId?: string;
    };
```

Browser selector 只作为 fallback，不能作为身份。导航、document revision、provider generation 或 observation 生命周期变化时，旧 ref 立即失效。

### 6.5 Action 与结果

```ts
interface SurfaceActionRequestV1 {
  version: 1;
  operationId: string;
  sessionId: string;
  predecessorStateId: string;
  target: SurfaceTargetRefV1;
  mutation: BrowserMutationV1 | ComputerMutationV1;
  expectation?: SurfaceExpectationV1;
  grantRef: string;
  deadlineMs: number;
  idempotencyKey?: string;
}

interface SurfaceActionResultV1 {
  version: 1;
  operationId: string;
  predecessorStateId: string;
  delivery: 'not_attempted' | 'confirmed' | 'rejected' | 'unknown';
  verification: 'preexisting' | 'satisfied' | 'unsatisfied' | 'inconclusive' | 'not_requested';
  overall: 'succeeded' | 'failed' | 'ambiguous' | 'delivered_unverified';
  successorState?: SurfaceObservationV1;
  evidenceRefs: string[];
  artifactRefs: string[];
  error?: SurfaceExecutionErrorV1;
}
```

该语义直接继承现有 Stateful CUA 的优点，并扩展给 Browser。`delivery=unknown` 时禁止自动重放点击、提交、输入或拖拽，必须先检查 successor state。

### 6.6 Event

```ts
interface SurfaceExecutionEventV1 {
  version: 1;
  eventId: string;
  sequence: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  surface: SurfaceKind;
  phase: 'prepare' | 'observe' | 'act' | 'verify' | 'human' | 'recover' | 'artifact' | 'cleanup';
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'ambiguous' | 'cancelled';
  userSummary: string;
  target?: SurfaceTargetRefV1;
  operation?: {
    action: string;
    risk: string;
    approvalScope?: string;
    expectedOutcome?: string;
  };
  observation?: {
    verdict: 'pass' | 'partial' | 'fail' | 'inconclusive' | 'not_requested';
    findings: string[];
    confidence?: number;
  };
  evidenceRefs: string[];
  artifactRefs: string[];
  availableControls: ('pause' | 'resume' | 'takeover' | 'skip' | 'stop' | 'end_session')[];
  startedAt: number;
  completedAt?: number;
}
```

`userSummary` 由 Host 确定性生成，模型可补充业务判断，但不能让可读体验只依赖可选 `shortDescription`。

## 7. 状态机

### 7.1 Session

```text
preparing
  → waiting_permission
  → running
  ↔ waiting_human
  ↔ paused
  → stopping
  → completed | failed
```

### 7.2 Observation

```text
fresh → consumed | superseded | expired
```

任何 mutation、重新观察、导航、provider restart 或目标 revision 变化都会让旧 observation 不可再次用于写操作。

### 7.3 Action

```text
queued → preflight → dispatching → verifying
       → succeeded | failed | ambiguous | cancelled
```

### 7.4 Human Takeover

```text
requested → human_control → resume_pending → running
          → cancelled | timed_out | navigated
```

## 8. Browser Adapter V2

### 8.1 Agent Window 与 tab lease

- Relay 每个 Surface Session 创建独立 Agent Window。
- Agent 自建 tab 可在该 Session 内读写。
- 用户 tab 由扩展 UI 发起选择和授权，Agent 不获得所有浏览器 tab 的完整标题与 URL 列表。
- 借用状态：

```text
available → consent_pending → leased → returning → returned
          → denied | expired | orphaned | recovery_required
```

- Lease 保存原 window、位置、domain、能力范围、批准时间、有效期与自动归还策略。
- Session stop 先取消命令，再归还 borrowed tab，最后关闭 Agent Window。
- 归还失败时保留现场并进入 `recovery_required`，不能伪装成完成。

### 8.2 Relay 授权修复

- 删除或封锁“收到任意 tabId 后自动 `debugger.attach`”的路径。
- `cdp.send`、截图、DOM、AX、console、network 和 mutation 全部先校验 session owner 与 tab lease。
- 未授权 tab 只允许扩展侧用户选择，Agent 侧不得读取内容或敏感 metadata。
- 配对使用短期、可轮换 token；完整 token 不进入 Renderer 共享合同或普通日志。
- 增加 protocol version、capability manifest、session id、operation id、cancel 和稳定错误。

### 8.3 目标与输入

- Browser observation 以 AX/DOM 组合生成 backendNode ref。
- mutation 通过 CDP `Input.*` 或 Playwright 真实输入执行。
- `querySelector().click()` 和直接赋值 `.value` 只保留为明确降级路径，并在 proof 中标记。
- iframe、OOPIF、Shadow DOM 在 P1 补齐；P0 至少保证 frame/document identity 不被错误复用。

### 8.4 Router

Router 只能根据以下信息选择 engine：

- 用户显式选择
- 目标 tab/domain 与 lease
- action capability
- 任务是否要求登录态复用
- localhost/preview/CI/隔离意图
- provider readiness

存在任意 attached tab 不足以自动选择 Relay。

## 9. Computer Adapter V2

### 9.1 保留的专属语义

- Computer 写操作是物理设备竞争资源，默认全局互斥。
- Grant 绑定 app/window，而不是只绑定整次 Session。
- 输入前校验目标 window revision、前台状态、坐标空间、DPI 和 screenshot identity。
- macOS TCC、Accessibility、Screen Recording、Input Monitoring 按结构化错误进入 recovery。
- takeover 时释放输入锁、鼠标按键和 modifier 状态。
- stop 时 abort provider、清理输入状态、释放 CUA lock。

### 9.2 迁移策略

- 现有 Stateful CUA 是 Surface Action Result 的母合同，优先上提并复用。
- legacy `computer_use` 先通过兼容 adapter 产生 Surface event，再逐步迁移执行路径。
- `computer_use` 中的 browser-scoped `locate_element`、`smart_click`、`smart_type`、`smart_hover` 迁入 Browser adapter；旧入口保留一段兼容期并产生 deprecation evidence。

## 10. 跨 Surface 切换

典型切换场景：

- Browser 遇到原生文件选择器、扩展弹窗、打印窗口或系统权限弹窗，切到 Computer。
- Computer 已进入浏览器页面且 DOM/AX 可用，切回 Browser 以获得更稳定、更低成本的定位和验证。

切换要求：

- 保留同一个 `runId` 和业务 step。
- 新建目标 Surface Session 或子会话，并记录父子关系。
- 明确展示切换原因、目标和新增授权范围。
- 上一 surface 的未完成 mutation 必须先收敛为 confirmed/rejected/unknown。
- proof 时间线能重建完整切换过程。

## 11. 会话执行体验

### 11.1 Surface Session Header

持续展示：

- 当前用户目标与阶段
- 当前 surface、provider、应用/页面/tab/window
- 当前控制者与授权范围
- 运行时间和最近一次心跳
- 暂停、我来操作、停止、结束 Session

### 11.2 Semantic Timeline

会话默认展示用户能理解的关键节点：

```text
观察  已打开生成后的旅游网站首页
操作  重新生成右侧 Hero 图片
验证  读取最新页面截图
判断  四个板块完整；第二张图片裁切异常
调整  修改提示词并重新生成
复验  新截图通过本轮视觉检查
```

低风险、高频点击、滚动和等待折叠为阶段摘要。以下节点始终展开：

- 授权、拒绝与权限扩大
- Surface 切换
- 截图读取和验证
- 用户接管
- 外部副作用
- 错误、恢复和重试
- 关键产物与最终 proof

原始 tool name、selector、trace id、JSON、console/network 细节放入“技术详情”。

### 11.3 Evidence Card

每次关键观察产生持久 Evidence Card：

- 缩略图或结构化证据类型
- 来源 URL、tab、app、window、viewport 和采集时间
- `captured → analyzing → analyzed → verified/rejected/inconclusive`
- 一到三条实际发现
- 检查项与 verdict
- 支持的判断和下一步动作
- redaction 状态与查看原始证据入口

Evidence 必须记录 `inspectedBy`、`inspectedAt`、`verdict` 和 `supportsStepIds`。只有图片字节真实进入视觉模型或确定性检查后，UI 才能显示“已读取”。

### 11.4 Outputs、Evidence、Sources

- Outputs：HTML、PNG、PPTX、下载文件等最终交付物。
- Evidence：截图、DOM、AX、console/network、before/after、verification result。
- Sources：用户文件、网页、输入图片和外部材料。

Outputs 在回合折叠后仍保留入口；Evidence 默认显示关键项，其余可展开；Sources 只读展示。

### 11.5 Dock 与 PiP

- Dock/PiP 用于实时观看当前 surface，不承担唯一证据职责。
- Browser 和 Computer 使用同一个 surface frame contract。
- 会话时间线持久保存关键 observation 和 verdict，Run 结束后仍可回看。
- Dock 必须提供 Pause、Take over、Stop，并显示实际生效状态。

## 12. 权限与安全

### 12.1 授权范围

Permission Card 必须展示：

- 目标 app/window 或 browser/tab/domain
- observe/input/navigate/file/secret/destructive 范围
- 数据可能进入模型、proof 或日志的范围
- 有效期与撤销方式
- 跳过或拒绝后的影响

默认选择为“允许一次”“本次任务”“拒绝”。高风险能力不提供无边界 Always。

### 12.2 敏感动作

- 密码、token、Cookie、Authorization、密钥材料、storage token 永不进入明文日志、proof、导出或 diagnostic bundle。
- console/network 默认只保留脱敏 metadata；request/response body 需要额外 policy。
- alert、confirm、prompt、beforeunload 默认暂停；支付、删除、授权场景必须显式批准。
- Profile Cookie Import 使用 Host 签发 approval，绑定 source profile、target profile、domain allowlist 和有效期；调用参数中的 `userConfirmed: true` 不再被视为充分授权。

## 13. 错误合同

稳定错误至少覆盖：

- 传输：`SURFACE_TRANSPORT_UNAVAILABLE`、`SURFACE_PROTOCOL_VERSION_MISMATCH`、`SURFACE_REQUEST_TIMEOUT`、`SURFACE_REQUEST_CANCELLED`、`SURFACE_USER_ABORTED`
- Session：`SURFACE_SESSION_NOT_FOUND`、`SURFACE_SESSION_EXPIRED`、`SURFACE_SESSION_BUSY`
- 所有权：`SURFACE_TARGET_NOT_OWNED`、`BROWSER_TAB_BORROW_REQUIRED`、`BROWSER_TAB_BORROW_DENIED`
- Observation：`SURFACE_STATE_STALE`、`SURFACE_TARGET_REVISION_CHANGED`、`SURFACE_ELEMENT_REF_NOT_FOUND`、`SURFACE_TARGET_AMBIGUOUS`
- 策略：`SURFACE_CAPABILITY_UNSUPPORTED`、`SURFACE_POLICY_BLOCKED`、`SURFACE_APPROVAL_REQUIRED`、`SURFACE_APPROVAL_INVALID`、`SURFACE_SECRET_SCOPE_MISMATCH`
- 执行：`SURFACE_DELIVERY_UNKNOWN`、`SURFACE_POSTCONDITION_FAILED`、`SURFACE_DIALOG_BLOCKED`、`SURFACE_CLEANUP_FAILED`

每个错误固定携带：

```text
phase · retryable · userActionRequired · recommendedAction
surface · provider · sessionId · targetRef · operationId · detailsSafe
```

## 14. P0：可信单任务闭环

### P0-A：合同与兼容层

- 新增 Surface Execution V1 判别联合合同。
- 以 Stateful CUA 的 state、delivery、verification、overall 和 successor state 为母语义。
- 把 Browser/Computer action catalog 变成可供 Host 校验的 capability registry。
- 现有 Browser/Computer 结果通过 adapter 产生 Surface event，保持旧消息和 replay 可读。

### P0-B：运行时控制面

- 建立 session owner、grant、observation lifecycle 和 operation queue。
- AbortSignal 贯穿 tool executor、orchestrator、provider 和扩展。
- 实现 pause、takeover、stop、end_session 四种不同语义。
- action mutation 后自动获取 successor observation 并验证 expected outcome。
- provider disconnect、restart、navigation、target revision change 都形成结构化 recovery。

### P0-C：Browser 可信边界

- Relay session 与 Agent Window。
- tab borrow/return lease，禁止任意 tabId 自动 attach。
- AX/backendNode ref 与真实输入。
- protocol handshake、capability、cancel、稳定错误。
- Host/扩展双重权限校验和 token 收紧。
- 阻塞式 human takeover。

### P0-D：会话执行 UX

- Surface Execution Card、Session Header、Semantic Timeline。
- Screenshot/DOM/AX 统一 Evidence Card。
- `captured/analyzed/verified` 独立状态。
- Outputs、Evidence、Sources 分离。
- Permission、Takeover、Recovery 卡片。
- 关键证据和产物在回合折叠后仍可见。
- Sidebar、Conversation、Composer、Dock/PiP 统一 Run 状态源。

### P0-E：验证与安全门

- 未授权 tab 内容读取和写入必须协议层拒绝。
- 两个 agent 不得访问对方 session、grant、tab 或 window。
- Stop 在目标时间内生效，停止后不再发新 mutation。
- borrowed tab 正常、失败、断线、扩展重启路径都能归还或进入可恢复状态。
- canary secret 不进入日志、proof、截图 metadata、导出和诊断包。
- Managed 与 Relay 各完成一个真实登录站点任务。
- Computer 完成一个真实 app 观察、mutation、验证和 takeover 任务。
- WorkBuddy 同型生成任务完整跑通会话展示闭环。

## 15. P1：可靠自动化与多任务

- Browser iframe、OOPIF、Shadow DOM、hover、drag、clipboard、dialog policy。
- Relay console/network 游标、真实截图 artifact、上传下载 parity。
- Browser Router 按 capability、target、domain、ownership 和 intent 选 engine。
- Computer foreground/background fallback 和输入锁恢复收敛到同一事件合同。
- 三个并行 Surface Session 独立查看、暂停、停止，无串线。
- Browser/Computer 自动切换及切换原因展示。
- 签名扩展、一键 pairing、doctor、升级和协议兼容流程。
- screenshot before/after 对比、检查清单和失败复验。
- 两套 proof finalizer 收敛为 SurfaceProofService。
- durable checkpoint 支持进程重启后的只读恢复和明确续跑。

## 16. P2：平台化与差异化

- 外部 Agent 的 `neo surface` / `neo browser` 适配器，继续执行同一 Session/Grant/Observation 合同。
- 多账号/profile、组织级域名/app 策略、审批审计和保留周期。
- 可回放 proof、失败现场复现、真实网站与真实 app 持续回归。
- Windows/Linux profile import 与 Computer provider。
- 多浏览器、远程 Managed provider、移动端和 in-app preview provider API。
- 基于真实使用量和 benchmark 决定远程 browser pool 与设备云投入。

## 17. 实施依赖顺序

```text
P0-A Contract
  ├─ P0-B Runtime control plane
  │    ├─ P0-C Browser trust boundary
  │    └─ Computer compatibility adapter
  └─ P0-D Conversation projection skeleton

P0-B + P0-C + P0-D
  → P0-E integrated acceptance
  → P1 capability/concurrency/recovery
  → P2 platformization
```

一个主实现 worktree 负责最终集成。可以使用内部 subagents 做只读审计、独立测试或文件边界清晰的子任务，但所有 public contract、迁移与最终验证由主 session 统一收口。

## 18. 测试与评测

### 18.1 自动化层级

1. Contract tests：schema、状态迁移、error、redaction、旧消息兼容。
2. Provider tests：grant、owner、state freshness、input delivery、cleanup。
3. Renderer tests：时间线投影、Evidence Card、控制状态、折叠策略。
4. Integration tests：Host、扩展、Renderer 事件链。
5. Browser E2E：真实 Chrome、动态页面、tab borrow/return、HITL。
6. Computer E2E：真实 app/window、AX/screenshot、takeover、stop。
7. App dogfood：WorkBuddy 同型生成与视觉复验任务。

### 18.2 基准语料

- T0 合同与红线 12 项：越权、取消、归还、版本偏差、泄漏、跨 session。
- T1 受控复杂任务 12 项：React 重排、iframe、上传下载、dialog、断线恢复、桌面前后台切换。
- T2 真实登录/真实 app 任务 12 项：测试账号、只读或可逆操作，覆盖登录复用、复杂表单、OTP 接力和视觉验收。

### 18.3 指标

- 端到端成功率、错误目标率、越权阻断率。
- 首次设置耗时、tool call 数、token、p50/p95 时延。
- 人工接管率、恢复成功率、Stop 延迟。
- proof 完整率、敏感数据泄漏率、跨 session 污染率。
- screenshot captured/analyzed/verified 状态准确率。
- 用户在五秒内识别进度、目标、介入要求和停止入口的比例。

### 18.4 P0 建议门槛

- T0 红线 100% 通过。
- 未授权读取或写入：0。
- secret 泄漏：0。
- 正常与失败路径 tab/lock cleanup：100%。
- Stop p95 小于 2 秒，停止后新增 mutation：0。
- 受控任务成功率不低于 95%。
- 故障注入恢复率不低于 90%。
- 用户测试中至少 90% 受测者五秒内回答当前进度、目标和介入要求。

真实任务整体成功率门槛在第一轮 baseline 后冻结；初始参考为不低于 85%，或相较当前 Neo baseline 提升至少 15 个百分点。

## 19. WorkBuddy 同型主验收

```text
生成网站
  → in-app browser 打开
  → 截图
  → 视觉分析
  → 判断不符合
  → 调整
  → 再截图
  → 验证通过
  → 展示产物
```

用户不展开技术详情，也能回答：

1. Neo 当前操作哪个页面或应用。
2. 任务已经进行到哪一步。
3. Neo 实际读取了哪张截图。
4. 从截图中发现了什么。
5. 为什么继续修改。
6. 最终由什么证据证明完成。

最终完成声明必须能反向追溯到 Action、Observation、Verification 与 Evidence。

## 20. 推荐验证命令

实施 session 先读取当时 `package.json`、CI 和相关测试，再以最新脚本为准。当前基线至少包括：

```bash
npm run typecheck
npm run lint
git diff --check
npx vitest run tests/renderer/utils/browserComputerActionPreview.test.ts
npx vitest run tests/renderer/components/browserComputerActionPreview.rendering.test.ts
npx vitest run tests/unit/evaluation/browserComputerProofTimeline.test.ts
npx vitest run tests/unit/session/browserComputerProofStore.test.ts
npx vitest run tests/unit/tools/vision/browserWorkbenchGating.test.ts
npx vitest run tests/unit/tools/vision/computerSurfaceGating.test.ts
npm run acceptance:browser-computer-all
npm run acceptance:tool-cancel
```

新增测试应覆盖 Surface contract、event projector、Evidence Card、Grant、tab lease、跨 agent 隔离、stop/takeover、真实 Browser/Computer E2E 和 WorkBuddy 同型验收。

全量 `npm test`、`npm run build`、repository structure 和相关 Playwright/E2E 在最终收口阶段执行。若隔离 worktree 缺少依赖，只能按仓内已验证方式临时只读复用主仓 `node_modules`，验证后移除；不得为环境问题修改 tsconfig、lockfile 或产品代码。

## 21. 兼容与迁移

- 新合同使用版本字段和判别联合。
- 旧 `browser_action` / `computer_use` tool 名保留，内部路由到 Surface orchestrator。
- 旧 ToolCall、proof、replay 和 session export 保持可读。
- 新事件写双读兼容期，Renderer 优先 Surface event，缺失时回退旧 action preview。
- `computer_use` 的 browser-scoped actions 保留短期 adapter，记录 deprecation telemetry 后迁移。
- 旧 Relay attached tab 状态不直接升级为有效 lease；升级后需要用户重新授权。
- 旧 Cookie import `userConfirmed` 仅用于兼容识别，不能签发新 Grant。

## 22. 主要风险与处理

| 风险 | 处理 |
|---|---|
| 共享合同过大导致迁移停滞 | 先做 adapter 和 event projection，逐条把执行强制迁入 |
| Browser/Computer 被错误抽象成同一目标模型 | 外层判别联合，内部保留 tab/document 与 app/window revision |
| Stop 无法撤销已送达副作用 | 返回 delivery unknown，观察 successor state，禁止自动重放 |
| 截图路径被误报为已观察 | 强制 captured/analyzed/verified 三态和 inspected metadata |
| Timeline 产生大量噪音 | 关键证据常显，低风险机械动作折叠，技术详情二级展开 |
| Relay 扩大真实 profile 风险 | Managed 默认；Relay 限时、限 tab、限 domain、限 action |
| console/network 泄漏凭据 | metadata-first、持久化前 redaction、canary 测试 |
| 多 Agent 并发导致跨 session 串线 | owner/grant/target triple check，三并发 E2E |
| P0 完成后实现会话提前停止 | Goal 明确要求完成 P0/P1/P2 或逐项记录经证据证明的 defer |

## 23. 决策门

- G0：接受 `Surface Execution V1 + Browser Adapter V2 + Computer Adapter V2 + Conversation Execution UX` 产品形态。
- G1：合同、状态机、权限模型、迁移和 UX 原型评审通过。
- G2：P0 红线、真实 Browser/Computer E2E 与 WorkBuddy 同型验收通过。
- G3：P1 并发、恢复、安装与跨 Surface 切换通过。
- G4：P2 外部 adapter、企业策略和远程 provider 依据真实需求与 benchmark 决策。

## 24. 完成定义

整个目标只有在以下条件全部满足时才能标记完成：

1. P0、P1、P2 每一项都标记为 implemented、verified 或 evidence-backed defer，并说明原因与后续决策门。
2. 共享合同进入真实 Browser 与 Computer 执行路径，而非只新增类型或 UI mock。
3. 会话内能持久展示关键动作、真实截图、观察判断、验证结果、接管和产物。
4. tab lease、grant、state freshness、取消、cleanup 和 redaction 红线测试通过。
5. Managed、Relay、Computer 与跨 Surface 代表性路径均有运行证据。
6. WorkBuddy 同型主验收通过。
7. 定向测试、typecheck、lint、build、repository structure、相关 E2E 与最终全量测试通过；任何环境阻塞单独列明。
8. 交付 completion audit、文件级变更、验证命令及结果、截图/日志证据、剩余风险和准确 HEAD SHA。
9. 未经用户明确授权，不执行 push、PR、merge、deploy、商店提交或生产写入。

## 25. 新实现 Session 的 Goal

```text
/goal 在 `/Users/linchen/Downloads/ai/code-agent` 的独立 worktree 中，以 `docs/plans/2026-07-20-surface-execution-browser-computer-use.md` 为唯一产品与验收真相源，完整实现 Neo Surface Execution V1、Browser Adapter V2、Computer Adapter V2 和 Conversation Execution UX，持续完成 P0、P1、P2，不得在只完成 P0、只新增合同、只做 UI mock 或只交付审计后提前结束。
验证：开工先读取仓内 AGENTS.md、该方案、ADR-037/041/043、package scripts、相关源码与测试，并记录 `origin/main`、HEAD、merge-base 和 worktree；每个阶段运行定向 Vitest、typecheck、lint 和 `git diff --check`，完成真实 Browser/Computer E2E、跨 Agent 隔离、越权阻断、tab 归还、stop/takeover、redaction canary、三并发 Session、WorkBuddy 同型“生成→浏览器打开→截图读取→判断→调整→复验→产物”验收；最终再运行 build、repository structure、相关 Playwright/acceptance 和全量测试，并保存日志、截图、proof、精确命令结果与 HEAD SHA。
约束：保持现有 tool 名、旧消息/replay/session export 兼容；Managed 默认承担隔离任务，Relay 仅在用户明确授权的 tab/domain/action/time scope 内复用登录态；Browser 与 Computer 共用控制平面和结果语义，各自保留目标、权限、输入与 cleanup 边界；不展示模型原始思维链；不弱化 proof、redaction、cookie/profile 隔离、RunRegistry、权限或现有 release gates；不因环境缺依赖而修改 tsconfig、lockfile 或产品语义。
边界：只修改 Surface Execution、Browser/Computer provider、Relay 扩展、会话执行展示、权限/证据投影、相关文档、测试与验收脚本直接涉及的文件；不改 node_modules、vendor、无关 Agent/模型/数据模块、用户配置、密钥或生产数据；不得 reset、clean 或覆盖其他人工作树；未经明确授权不得 push、PR、merge、deploy、发布或提交扩展商店。
迭代策略：先做 completion audit 和依赖图，再按 P0-A 合同、P0-B 控制面、P0-C Browser 边界、P0-D 会话 UX、P0-E 集成验收推进；P0 过门后继续 P1 与 P2，每个阶段更新计划和证据；可以用 subagents 并行处理边界清晰的审计、测试和组件，但 public contract、迁移与最终验证由主 session 统一收口；一次只做一个可验证切片，每次有意义改动后重跑最小相关检查，同一问题连续失败两次必须读取新证据或更换策略，超过 30 分钟或跨会话必须重新 fetch 并核对基点。
完成条件：本方案第 24 节全部完成，P0/P1/P2 每项都有 implemented、verified 或 evidence-backed defer 结论，真实 Browser、Computer、跨 Surface 与 WorkBuddy 同型主验收有可复核证据，最终工作树干净或仅保留明确交付文件，并提交 completion audit、文件级变更、验证结果、剩余风险和 HEAD SHA；不能把“动作调用成功”当作业务验证，也不能把旧构建、旧截图或 mock 当成最终运行证据。
暂停条件：需要用户账号、验证码/MFA、付费服务、生产数据、密钥、系统权限、不可逆动作、商店签名/发布、产品范围扩大或现有公开合同无法兼容时暂停并给出最小决策；同一外部阻塞连续三轮没有变化时按 Goal 规则标记 blocked；ship、测试或安全门失败时 fail-closed，不得 force、跳过或手工绕过。
```
