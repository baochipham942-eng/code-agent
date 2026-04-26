# ADR-011: Chat-Native Workbench — 把能力入口收到聊天主链路

> 状态: accepted
> 日期: 2026-04-18
> 关联: `docs/architecture/workbench.md`、`docs/plans/2026-04-16-chat-native-agent-workbench-plan.md`、`docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`

## 背景

在 2026-04-16 之前，`code-agent` 的能力已经相当完整：workspace 有独立 store/IPC/UI；skills/MCP/connectors 各有自己的面板和生命周期；swarm/multi-agent 有 `CoworkContract + launch approval + TaskPanel/Orchestration + SwarmMonitor`；browser/computer-use 有专门工具链。

但从产品形态看，它们是**五组并列的 sidecar**。用户发一条普通消息时，主聊天输入框只承载文本；要用上任一项能力，必须先去对应的面板里设置好，再回到聊天发送。Observability 也集中在控制台式的 `SwarmMonitor / Orchestration` 里，普通用户在聊天里看不懂"现在在干什么"。

跟 `Accio Work` 做对标分析后得出：

> `Accio` 是 `chat-native multi-agent`；`code-agent` 是 `orchestration-native multi-agent`。差距不在引擎，在产品壳。

因此需要一个结构性决策：要不要把聊天主链路本身改成能力工作台。

## 决策

**采纳**：在聊天主链路上新增一层 Workbench，作为 workspace / skills / MCP / connectors / routing / browser 的统一前台入口。

实现骨架：

1. **聊天发送结构升级**：`agent:send-message` 从散装参数升级为 `ConversationEnvelope`，携带 `context.workingDirectory / routing / selectedSkillIds / selectedConnectorIds / selectedMcpServerIds / browserSessionMode / executionIntent`。旧 payload 由 `normalizeEnvelope()` 兼容，不回归。
2. **输入区前置**：在 `ChatInput` 上方新增 `InlineWorkbenchBar`；`composerStore` 单独管理"本次发送前的临时选择态"，不塞进 `appStore / sessionStore`。
3. **审批回流**：swarm launch approval 以 `LaunchRequestCard` 出现在聊天 turn 内；同一组件被 TaskPanel 与聊天 trace 共用。
4. **执行解释投影**：新增 `turn_timeline` 节点类型，承载 `workbench_snapshot / blocked_capabilities / routing_evidence / artifact_ownership` 四层。由 `useTurnProjection()`（纯切分）+ `useTurnExecutionClarity()`（enrichment）两层 hook 完成。
5. **Direct Routing 持久化**：`@agent` 不再是 renderer-only 短路；主进程 `swarm:send-user-message` 先持久化再 fanout，失败 renderer 回滚 optimistic 消息。持久化的 `metadata.directRoutingDelivery` 作为 replay fallback。
6. **Auto Routing 结构化事件**：主进程发出 `routing_resolved` 事件；renderer 写入 `turnExecutionStore`。不再由 renderer 解析 notification 文案。
7. **Review Queue 统一 trace identity**：Replay / Eval Center / Review Queue / session list 共享 `session:<sessionId>` 形式的稳定 identity。失败会话经 `failure_followup` sink 回流到 Review Queue；历史 session 的 workbench 配置可回灌当前 composer。

**不采纳**：

- 不重写 swarm / cowork / subagent 引擎
- 不替换 `TaskPanel / SwarmMonitor / TurnBasedTraceView` 的全部实现
- 不引入 Accio 式 team 容器和 `channelMembers` 数据模型
- 不做"插件商城"式 capability marketplace

## 选项考虑

### 选项 1：只补入口（在现有 sidecar 上加快捷按钮）

- 优点：改动小，风险低，不动主链路。
- 缺点：根本问题是"能力分散在五个入口"，多加快捷按钮只是多一个分发点。用户心智仍然是"先去面板配置，再回来发消息"，沟通成本并没减少。实际上这条路已经隐性走了一段（TaskPanel 的 working folder、skills 下拉），收益边际递减。

### 选项 2：重做 team / channel 数据模型（抄 Accio）

- 优点：长期看能达到 Accio 的"聊天原生 multi-agent"完整形态。
- 缺点：需要改 `CoworkContract / SessionStateManager / channelMembers` 等底层数据模型，工程量巨大，风险高。而且当前差距大多在产品壳——工程层并不缺能力。用"推倒重做底层"换"改产品壳"，性价比低。

### 选项 3（采纳）：只改产品暴露方式，不动 orchestration 引擎

- 优点：
  - 工程量可控：新建 `ConversationEnvelope` contract、`composerStore`、`turnTimeline` 契约 + renderer 侧 hook/组件；主进程改动集中在 `agentOrchestrator.sendMessage()` 的 `messageMetadata` 参数 + `swarm.ipc.ts` 的持久化顺序 + 新增 `routing_resolved` 事件。
  - 可以渐进落地：5 条概念流各自独立，phase 内部有 slice 拆分，任何一步失败不阻塞其他。
  - 回滚成本低：旧 payload 兼容，旧 trace 兼容，旧 TaskPanel 保留。
  - 不赌团队规模：不需要引入大改底层数据模型。
- 缺点：
  - 存在短期双维护面：`TaskPanel` 与聊天主链路会短暂承载同样信息（launch approval / workspace 展示）。通过共用组件（`LaunchRequestCard` / `WorkbenchCapabilitySheetLite`）压降重复。
  - state 边界更复杂：`composerStore` 加到 `appStore / sessionStore / swarmStore / skillStore` 之外，边界必须坚持"只管发送前临时选择"，否则会漂移。

## 后果

### 2026-04-26 实施补充

ADR-011 的方向没有改变，但产品入口在后续实现里进一步收窄：

- ChatInput 不再承载 AbilityMenu；低频动作进入 `+` 菜单，Routing / Browser 默认偏好进入 Settings “对话”tab
- Live Preview 从每轮输入的能力菜单迁出，成为 session/workspace 级入口，并补齐 DevServerLauncher 与 TweakPanel
- Browser / Computer 从显式入口推进到生产化基线：managed browser session/profile/account/artifact/lease/proxy/TargetRef 与 Computer Surface background AX/CGEvent 都有验收
- Tool trace 从“工具名 + 参数”升级为 semantic tool UI：`_meta.shortDescription`、target icon、memory citations、session diff summary 进入主聊天渲染
- OpenChronicle / Tauri Native Desktop 的 screen memory 入口被归入 Activity Providers，不再让单一 provider 定义 prompt 注入架构

这批补充仍然遵守原决策：不重写 orchestration 引擎，不引入 team/channel 大模型，不做 capability marketplace。

### 积极影响

- 聊天主链路承载 workspace / routing / capability 的**选择、执行、解释**全流程，TaskPanel 降级为高级控制面
- 主进程成为 `ConversationEnvelope` 的唯一消费者，renderer optimistic 不再承担事实源；Direct routing 变成可重放、可回看的真实链路
- Turn 级 `turn_timeline` 是 workbench / blocked / routing / artifact 的统一投影层，后续 TaskPanel 或其他面板若要复用，只复用 DTO 和纯 builder
- Review Queue / Replay / session list 共享 trace identity，评测和产品不再是两套数据源

### 消极影响

- 状态管理复杂度上升：新增 `composerStore / turnExecutionStore`。需要严格遵守"composer 只管发送前临时态、turnExecution 只做 live ephemeral buffer"的边界。
- renderer 侧 hook 链路变长：`useTurnProjection → useTurnExecutionClarity → TraceNodeRenderer`。分层收益明确（切分 vs enrichment vs 渲染），但新加节点类型时要记得四处都对齐。
- 部分能力只做了"解释层"，未做"修复动作"：connector blocked 只展示 reason + hint，没有一键 connect / retry。Desktop readiness gate 只区分 mode，未做 permission 前置 gate。

### 风险

1. **"选择"和"执行"脱节被误以为 bug**：用户选了 blocked 的 connector，看到 timeline 说"本轮不会调用"，可能误解为系统坏了。缓解：`blocked_capabilities` 节点必须给明确 reason + next-step hint，不做 dimmed pill。
2. **Auto routing evidence 与 turn 错配**：`routing_resolved` 事件可能晚于下一个 turn 开始。缓解：只在"每 session 同时只有一个 active non-direct turn"假设下绑定最近 turn；无可绑定 turn 则丢弃 evidence，不强贴。
3. **artifact ownership 跨 run 污染**：`SwarmAgentState.filesChanged` 没有稳定的 `turn ↔ swarm run` join key。缓解：Phase 2 只扫当前 turn 的 assistant/tool artifacts，不回灌 swarm aggregation。
4. **后端 prompt 上下文污染**：如果把 UI 选择直接灌进 prompt，模型行为会变差。缓解：envelope 只做结构化 metadata 注入，prompt builder 单独决定投影哪些字段，两者解耦。

## 相关文档

- 架构稳定态：[docs/architecture/workbench.md](../architecture/workbench.md)
- 产品需求：[docs/PRD.md](../PRD.md#314-chat-native-workbench主链路交互结构)
- 设计稿与 implementation spec：
  - `docs/plans/2026-04-16-chat-native-agent-workbench-plan.md`
  - `docs/plans/2026-04-16-phase1-chat-native-workbench-implementation-spec.md`
  - `docs/plans/2026-04-17-phase2-execution-clarity-implementation-spec.md`
  - `docs/plans/2026-04-17-chat-native-workbench-next-phase-roadmap.md`
- 竞品分析：`docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`
- 整合 commit：`0a6e215e feat(workbench): chat-native agent workbench phase 1-2 (integration)`
