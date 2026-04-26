# Chat-Native Agent Workbench 详细设计

日期：2026-04-16
状态：历史设计稿（已按 2026-04-26 实际状态补充对齐）
关联分析：`docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`

## 0. 使用方式

这份文档保留 `2026-04-16` 当天的原始设计判断。

- 第 `3-14` 节描述的是当时的待实现问题与原计划，不应再直接当成当前状态说明。
- 当前真实产品口径，以本节和后续 implementation spec / roadmap 里的“`2026-04-26` 实际状态”说明为准。

## 0.1 2026-04-18 实际状态对齐

- `Phase 1` 已交付并关账：`ConversationEnvelope`、`InlineWorkbenchBar`、聊天内联 `LaunchRequestCard` 已进入主链路。
  - 证据：`src/renderer/stores/composerStore.ts`、`src/renderer/hooks/useAgent.ts`、`tests/renderer/stores/composerStore.test.ts`、`tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `Direct routing` 已不再是 renderer-only optimistic 假象。renderer 仍先写 optimistic user message，但主进程 `swarm:send-user-message` 会先把 user message 持久化进当前 session，再 fanout；历史 reload / Replay 可通过持久化 metadata 与 replay fallback 重建这条链。
  - 证据：`src/renderer/hooks/useAgent.ts`、`src/main/ipc/swarm.ipc.ts`、`src/main/services/core/repositories/SessionRepository.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`src/main/evaluation/telemetryQueryService.ts`、`tests/unit/ipc/swarm.ipc.test.ts`、`tests/unit/evaluation/telemetryQueryService.test.ts`、`tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `Connector lifecycle` 还不能写成“已产品化完成”。当前只做到统一 registry / sheet、真实 blocked reason / hint；connector 没有一键 `connect / retry` 闭环。
  - 证据：`src/renderer/utils/workbenchCapabilityRegistry.ts`、`src/renderer/utils/workbenchQuickActions.ts`、`src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx`、`tests/renderer/utils/workbenchQuickActions.test.ts`、`tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- `Phase 6` 当前完成定义是：`6.1 Unified Trace Identity` 已落、`6.2 Review Queue` 已落、`6.3` 只落 `failure_followup` sink、`6.4` 只落 `session-backed reuse`。命名 `preset/recipe` 资产库和 `failure-to-capability` 多分流仍在 backlog。
  - 证据：`src/shared/contract/reviewQueue.ts`、`src/main/evaluation/reviewQueueService.ts`、`src/main/evaluation/telemetryQueryService.ts`、`src/renderer/stores/evalCenterStore.ts`、`src/renderer/components/features/evalCenter/ReplayAnalyticsSidebar.tsx`、`src/renderer/components/Sidebar.tsx`、`src/renderer/stores/composerStore.ts`、`tests/unit/evaluation/reviewQueueService.test.ts`、`tests/renderer/stores/evalCenterStore.reviewQueue.test.ts`、`tests/renderer/components/evalCenter.replayAnalyticsSidebar.failureFollowup.test.ts`、`tests/renderer/components/sidebar.reviewActions.test.ts`、`tests/e2e/review-queue.e2e.spec.ts`

## 0.2 2026-04-26 实际状态补丁

这份设计仍然解释“为什么要做 chat-native workbench”，但具体入口和能力边界已经升级：

- Workbench B+：ChatInput 不再堆低频控制，`+` 承载附加动作和模式切换；Settings “对话”tab 承载 Routing / Browser 偏好；Sidebar User Menu 承载全局页面入口。
- Live Preview V2-A/B：`devServerManager`、`DevServerLauncher`、bridge protocol 0.3.0、`TweakPanel` 和 Tailwind 原子改写已落；Next.js App Router 支持按 ADR-012 延期。
- Browser / Computer：in-app managed browser 已有 BrowserSession/Profile/AccountState/Artifact/Lease/Proxy/TargetRef/stale recovery/download/upload/benchmark；external / remote browser 仍是未交付边界。
- Activity Providers / Semantic Tool UI：屏幕活动上下文和工具调用展示都进入统一语义层，不再只依赖原始 tool/event payload。

## 1. 目标

把 `code-agent` 当前“能力强但入口分裂”的产品形态，收敛为更接近 `chat-native agent workbench` 的用户体验。

核心目标不是复制 Accio 的所有 UI，而是解决这四个产品问题：

1. 多代理编排是 sidecar，不是聊天主链路
2. workspace / MCP / skills / connectors 没有一次性进入会话发送链
3. browser / computer-use 缺少显式接入心智
4. observability 太偏控制台，普通用户难以在聊天里理解“现在发生了什么”

## 2. 非目标

这轮不做：

- 重写 swarm / cowork / subagent 底层执行引擎
- 替换现有 `TaskPanel`、`SwarmMonitor`、`TurnBasedTraceView` 的全部实现
- 重新设计 plugin / skill / MCP 后端协议
- 引入 Accio 式 team 容器和 channelMembers 数据模型

这轮的重点是：

`把现有能力收口成更统一的前台入口`

## 3. 当前架构约束

### 3.1 聊天发送链当前过窄

当前主聊天发送链的 payload 只有：

- `content`
- `sessionId`
- `attachments`
- 可选 `options`

证据：

- [useAgent.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useAgent.ts:730)
- [agent.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/agent.ipc.ts:18)

这意味着：

- `workingDirectory`
- `selected skills`
- `selected MCP/connectors`
- `routing intent`
- `launch approval intent`

都没有进入主聊天的显式请求模型。

### 3.2 前端是多面板架构

当前前端已经有：

- `ChatView`
- `TaskPanel`
- `SkillsPanel`
- `CronCenter`
- `FileExplorer`

证据：

- [frontend.md](/Users/linchen/Downloads/ai/code-agent/docs/architecture/frontend.md:1)
- [appStore.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/stores/appStore.ts:27)

这说明系统并不缺 UI 容器，问题是：

`能力入口分散，没有单一主路径`

### 3.3 多代理已经有完整底座

当前已有：

- `CoworkContract`
- `CoworkOrchestrator`
- `swarmStore`
- `launch approval`
- `trace persistence`
- `AgentTeamPanel`

所以设计策略应该是：

`不改 orchestration 核心，先改 orchestration 的产品暴露方式`

## 4. 目标产品形态

目标形态不是“聊天 + 一堆侧面板”，而是：

`聊天是主入口，其他面板退化为高级控制面`

### 4.1 主链路

用户理想路径：

1. 在主输入框里描述任务
2. 在输入框附近完成必要的上下文选择
3. 发送后，聊天流里先看到“准备执行”的结构化卡片
4. 若需要并行 / 浏览器 / MCP / 技能 / 工作目录，仍在聊天流里确认
5. 执行开始后，在当前 turn 内看到：
   - 当前分工
   - 当前活跃 agent
   - 当前使用的 workspace / skills / tools
   - 关键审批与中断点
6. 高级追踪再进入右侧控制面

### 4.2 控制面降级

保留但降级为高级面板：

- `TaskPanel`
- `SwarmMonitor`
- `AgentTeamPanel`
- `CronCenter`

它们不再是“默认心智入口”，而是：

`当用户需要更深调试和运维控制时才进入`

## 5. 设计总览

本方案拆成 5 个设计块：

1. `ConversationEnvelope`：扩展会话发送载荷
2. `Inline Workbench Bar`：把 workspace / skills / MCP / routing 收到输入框附近
3. `Inline Launch Card`：把 swarm launch approval 拉回聊天流
4. `Turn Workbench Trace`：把 swarm/replay 的关键事件投影进当前 turn
5. `Explicit Browser Session`：为 browser/computer-use 提供显式接入心智

---

## 6. 设计块 A：ConversationEnvelope

### 6.1 问题

当前 `agent:send` 不承载用户选择的“执行上下文”。

这会导致：

- 选择 workspace 是 UI 状态，不是消息状态
- skills / MCP / connectors 是独立入口，不是当前会话的一部分
- 多代理路由意图无法在消息层显式表达

### 6.2 新增抽象

新增一个前台可见、后端可消费的消息外壳：

```ts
interface ConversationEnvelope {
  content: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
  options?: AppServiceRunOptions;
  context?: {
    workingDirectory?: string | null;
    selectedSkillIds?: string[];
    selectedConnectorIds?: string[];
    selectedMcpServerIds?: string[];
    routing?: {
      mode: 'auto' | 'direct' | 'parallel';
      targetAgentIds?: string[];
    };
    executionIntent?: {
      allowParallelPlanPreview?: boolean;
      preferBrowserSession?: boolean;
    };
  };
}
```

### 6.3 影响面

前端：

- `ChatInput/index.tsx`
- `useAgent.ts`
- `sessionStore` / `appStore` / 新建 `composerStore`

主进程：

- `agent.ipc.ts`
- `appService.sendMessage(...)`
- runtime context assembly

### 6.4 原则

- `ConversationEnvelope` 是“消息级上下文”，不是全局设置快照
- 能写进 turn metadata 的都尽量写进 turn metadata
- UI 当前选择和消息最终发送内容要一一对应

---

## 7. 设计块 B：Inline Workbench Bar

### 7.1 目标

把这几个分裂入口收口到输入框附近：

- workspace
- skills
- MCP / connectors
- routing mode

### 7.2 新 UI 结构

在 `ChatInput` 上方新增一层 `InlineWorkbenchBar`：

```text
┌──────────────────────────────────────┐
│ Workspace  Skills  MCP  Routing      │
│ /repo      2 mounted mcp:github Auto │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ Chat input                           │
└──────────────────────────────────────┘
```

### 7.3 交互规则

`Workspace`

- 显示当前工作目录
- 可点击切换目录
- 无目录时显示轻量 placeholder，而不是只在 `TaskPanel/WorkingFolder` 中可见

`Skills`

- 显示当前会话已挂载 skills 数量
- 可展开轻量选择器
- 仍复用现有 skill store 和技能挂载逻辑

`MCP / Connectors`

- 先不追求完整 connector marketplace
- 第一阶段只显示已连接 / 已启用的 server 数量与快速切换

`Routing`

- 提供三个模式：
  - `Auto`
  - `Direct`
  - `Parallel`
- `Direct` 时可选择一个或多个 agent

### 7.4 状态归属

新增 `composerStore`，负责“输入时的临时上下文选择”：

```ts
interface ComposerState {
  workingDirectory: string | null;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  routingMode: 'auto' | 'direct' | 'parallel';
  targetAgentIds: string[];
}
```

原则：

- `appStore` 继续管理全局 UI 开关
- `sessionStore` 管理持久会话
- `composerStore` 专门管理“本次发送前的上下文组合”

---

## 8. 设计块 C：Inline Launch Card

### 8.1 目标

把当前 swarm launch approval 从：

`状态条 -> TaskPanel -> Orchestration`

改成：

`当前聊天 turn 内联卡片`

### 8.2 设计

当后端发出 `swarm:launch:requested` 时：

- 仍然写入 `swarmStore`
- 但同时在当前会话追加一个新的系统消息节点：
  - 类型：`swarm_launch_request`
  - 内容：任务摘要、agent 数量、依赖数、写权限概览
  - 操作：`开始执行` / `取消编排`

### 8.3 渲染位置

优先复用现有 turn-based 体系：

- 在 `TurnBasedTraceView`
- 或 `TurnCard / TraceNodeRenderer`

新增一个 node renderer：

```ts
type TraceNode =
  | ...
  | { type: 'swarm_launch_request'; payload: SwarmLaunchRequest }
```

### 8.4 价值

这一步是整个方案里 ROI 最高的改动，因为它直接改变用户心智：

- 从“我被带到控制台去确认”
- 变成“我在对话里看到系统准备怎么干”

---

## 9. 设计块 D：Turn Workbench Trace

### 9.1 问题

当前：

- `SwarmMonitor` 很强
- `trace persistence` 很完整
- `TurnBasedTraceView` 也存在

但这三者没有收成一个“普通用户看得懂的执行过程表达”。

### 9.2 新目标

在当前 turn 内引入轻量 workbench trace，默认只显示：

- 当前 routing mode
- 活跃 agent
- 当前 stage
- 关键工具 / skills / MCP 使用
- 关键审批状态

展开后才显示更多细节。

### 9.3 渲染形式

新增 `TurnWorkbenchTraceCard`：

```text
并行执行中
Agent: planner, coder, reviewer
Workspace: /repo/app
Skills: 2
MCP: github
Stage: coder -> reviewer
```

展开后显示：

- 当前 launch request 详情
- 当前 plan review 状态
- 当前 agent 输出摘要

### 9.4 数据来源

不新造后端协议，先用现有数据拼：

- `swarmStore`
- `sessionStore.messages`
- `taskPlan`
- `workingDirectory`

中期再补统一投影层：

`useWorkbenchProjection(sessionId)`

---

## 10. 设计块 E：Explicit Browser Session

### 10.1 问题

当前 browser/computer-use 更像工具能力：

- agent 自己决定何时调用
- 用户不知道“到底控制的是哪个浏览器/桌面对象”
- browser readiness 不是显式产品状态

### 10.2 目标

引入 `Browser Session` 概念：

- 作为 workbench bar 的一个小入口
- 表达“当前有没有可用浏览器执行上下文”

### 10.3 第一阶段不做什么

不直接重构成 Accio 那种“接现有 Chrome 扩展”的完整方案。

先做更小的版本：

- 在 UI 中显式表达 browser state
- 当任务可能依赖 browser/computer-use 时，先弹出内联提示卡
- 提供：
  - `Launch browser`
  - `Use existing browser context`（若未来支持）
  - `Skip browser path`

### 10.4 结果

哪怕底层还是 Playwright / GUI tool，用户心智也会从：

`怎么突然开始调浏览器工具了`

变成：

`这次任务会用到浏览器，我确认一下执行环境`

---

## 11. 渐进式落地顺序

### Phase 1：消息外壳与聊天内联审批

范围：

- 引入 `ConversationEnvelope`
- 新建 `composerStore`
- `ChatInput` 上方增加最小版 `WorkbenchBar`
- 聊天流中渲染 `InlineLaunchCard`

不做：

- 完整 skills/MCP 选择器
- 浏览器会话管理
- turn 内详细 trace

验收：

- 用户能在主输入框附近看到工作目录与 routing mode
- swarm launch approval 不必跳到右侧面板也能完成

### Phase 2：把 workspace / skills / MCP 真正接进发送链

范围：

- 发送 payload 带上 `workingDirectory / skills / selected connectors`
- 聊天消息 metadata 可回显这些选择
- 主链路不再依赖“用户先去几个侧栏里设置好”

验收：

- 同一条消息能明确带上工作目录、skills、MCP 选择
- 会话回放中能看到这些上下文

### Phase 3：Turn 内可观察性

范围：

- 新增 `TurnWorkbenchTraceCard`
- 从 `swarmStore` 投影出用户可读状态
- 保留 `TaskPanel` 作为高级控制面

验收：

- 用户不打开右侧面板也能理解任务是否并行、谁在干活、当前处于哪一阶段

### Phase 4：显式 browser session

范围：

- WorkbenchBar 中加入 browser state
- 任务需要 browser/computer-use 时给出内联前置提示

验收：

- browser/computer-use 不再是纯隐式工具调用
- 用户知道这次任务是否依赖浏览器执行上下文

---

## 12. 风险

### 风险 1：状态重复

现在已经有：

- `appStore`
- `sessionStore`
- `swarmStore`
- `skillStore`
- `localBridgeStore`

再加 `composerStore` 可能导致状态分裂。

应对：

- 明确边界
- `composerStore` 只管“发送前上下文”
- 所有已发送内容以 message metadata 为准

### 风险 2：会话历史兼容性

旧消息没有 `ConversationEnvelope.context`。

应对：

- 新字段全部 optional
- 渲染层做 feature detection

### 风险 3：Turn 内 trace 太吵

如果把 swarm 所有事件都塞进聊天，会让主线程变脏。

应对：

- 默认只显示摘要
- 保留展开层级
- 继续保留右侧控制面承接深度细节

### 风险 4：后端模型上下文污染

如果把太多 UI 选择直接灌进 prompt，可能让模型行为变差。

应对：

- 先做结构化 metadata 注入
- prompt 中只投影必要上下文
- 保持 envelope 与 prompt builder 解耦

---

## 13. 验收标准

### 产品验收

1. 用户可以在不打开 `TaskPanel` 的情况下完成一次并行任务启动
2. 用户可以在主输入区明确看到本次消息绑定的 workspace 和 routing mode
3. 用户可以在聊天流里理解：
   - 是否进入并行执行
   - 目前有哪些 agent 在工作
   - 这次执行用了哪些上下文能力

### 工程验收

1. `agent:send` 支持新的 envelope 结构，旧调用不回归
2. `swarm:launch:requested` 可同时驱动：
   - 旧的 `swarmStore`
   - 新的聊天内联 launch card
3. `TaskPanel` 与新主链路并存，不互相阻塞

### 体验验收

1. 多代理相关的第一次心智入口在聊天主线程，而不是右侧控制台
2. workspace / skills / MCP 不再需要用户先记得去多个入口设置
3. 普通用户能“在聊天里理解执行”，高级用户仍能进入控制面深挖

---

## 14. 最终判断

这轮设计的本质不是“补功能”，而是：

`把已有功能改造成更统一的聊天原生产品路径`

如果只做一个版本，优先级应该是：

1. `InlineLaunchCard`
2. `ConversationEnvelope`
3. `InlineWorkbenchBar`

因为这三步一旦完成，`code-agent` 的用户感知会先从“控制台式编排工具”变成“聊天原生 agent workbench”。
