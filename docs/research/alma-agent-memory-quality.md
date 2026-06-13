# Alma Agent / Memory Quality 对标研究

> 日期：2026-06-13  
> 范围：Alma 设置页与会话页联动，重点看 agent、记忆、retrieval indicators、模型/任务策略、会话质量控制。  
> 资料：`/tmp/alma-update-20260613/release-notes-805-823.md`，`old/extract/renderer-assets/index-DZO6LH4W.js`，`new/extract/renderer-assets/index-lrtJ1hZ1.js`。  
> 边界：只做研究和方案，不开发产品功能。

## 1. 核心判断

Alma 值得借的核心，是把“设置里配置过的能力”变成会话页里可见的质量信号。模型、工具、技能、记忆不只存在于配置项里，还贴在 assistant 输出附近，用户能立刻判断这次回答是否用了正确上下文。

code-agent 的底层能力更厚：有 Light Memory、DB memory、Memory Entry 状态治理、memory pack、模型路由决策、Agent Engine、角色记忆、turn trace、tool display、memory citation。但这些信号分散在设置页、Knowledge 面板、TaskPanel、trace chip、tool detail 里，没有形成一条“这条回复为什么可信”的消息级解释链。

后续开发优先级应该放在 P0 的会话可见性：把每轮使用的记忆、模型策略、agent / skill / tool 选择做成 assistant 输出上的轻量指标和可展开来源。P1 再做任务策略化模型选择、记忆纠偏闭环和会话质量评估。

## 2. Alma 证据

### 2.1 产品语言从聊天工具转成任务型 agent

`v0.0.807` release notes 有三个信号：

- 新增 `Plugins & Providers` 设置区和 provider setup banner。
- onboarding / docs 把 Alma 描述成 `local-first, memory-first AI agent`。
- 文档把 `main chat model` 改成 `main task model`，并提醒不要选择过慢或过贵的模型。

这组措辞说明 Alma 在把模型选择从“聊天偏好”改成“任务执行策略”。它关心的是这个 agent 完成任务时用什么主模型、什么时候调用工具、什么时候用记忆，而不只是用户在聊天框里挑一个模型。

### 2.2 会话页有三层 retrieval indicator

新 renderer 里能看到同一套指标在多个阅读位置出现：

- Thinking / reasoning 折叠头：`ReasoningContext` 传入 `autoSelectedTools`、`autoSelectedSkills`、`memories`，`ReasoningTrigger` 展示 Brain / Wrench / WandSparkles 计数和 tooltip。
- Assistant message 顶部：当消息没有 reasoning part 时，`showToolsMemoriesIndicator` 会在内容前显示 retrieved memories、auto selected tools、auto selected skills。
- Typing indicator：生成过程中接收 `memoryRetrievalStage`、`memoryRetrievalMessage`、`retrievedMemories`，显示“retrieving”和已检索条数。

这些指标的作用是把“系统偷偷做了检索”改成“我看到它检索了几条，并能扫到内容片段”。记忆不再只是长期上下文的黑盒。

### 2.3 Memory indicator 支持输出后的追责

Alma message menu 里还有 `usedMemories`、`createdMemories`、`deletedMemories` 三类列表。也就是说，用户不仅能看到生成前/生成中检索了什么，还能在输出后看这条消息实际用了哪些记忆、写了哪些新记忆、删了哪些记忆。

这对信任很关键：用户看到一条答复不对时，可以把错误定位到“取错记忆”“没有取记忆”“生成后写坏记忆”这几类问题，问题来源会更具体。

### 2.4 版本归因要谨慎

旧 renderer 里也能检索到 `autoSelectedTools`、`autoSelectedSkills`、`retrievedMemories`、`usedMemories`、`createdMemories`、`deletedMemories` 和同类 UI 逻辑。所以这些 indicator 很可能早于 805 到 823 这段更新周期。

本次对标价值不在“某个版本刚发布了什么”，而在 Alma 已经形成了稳定产品模式：设置页配置能力，会话页展示能力是否真正参与了输出。

## 3. code-agent 当前锚点

### 3.1 记忆系统

当前代码里已经有两套可治理记忆：

- `src/renderer/components/features/settings/tabs/MemoryTab.tsx`：Light Memory 文件管理、导入预检、搜索、删除确认。
- `src/renderer/components/features/settings/tabs/MemoryEntriesManager.tsx`：统一管理 Light Memory 和 DB memory，支持状态、类型、标题、摘要、正文编辑，支持归档和删除。
- `src/shared/contract/memory.ts`：`MemoryEntryStatus = candidate | active | rejected | stale | archived`，并保留 `evidence`。
- `src/main/memory/memoryEntryRuntime.ts`：`packMemoryEntries` 默认只选 `active`，按 scope、query token、confidence、BM25 召回、score reasons 和预算选入上下文。
- `src/main/utils/seedMemoryInjector.ts`：会话开始时构建 seed / packed memories，失败不会阻断 agent loop。
- `src/main/agent/runtime/contextAssembly/messageBuild.ts`：按用户意图注入 `memory_index`，日常轮次注入 `memory_hint`，并记录 injection trace。
- `src/main/memory/memoryInjectionTrace.ts`：记录 blockType、trigger、chars、injected、source、count、sessionId。
- `src/renderer/components/features/knowledge/KnowledgeMemoryPanel.tsx`：在 Knowledge 面板展示最近 Injection Trace。

结论：code-agent 已经能解释“哪些记忆有资格进入候选、为什么被选、来源证据是什么”。缺口是这些信息没有自然地出现在当前 assistant 输出旁边。

### 3.2 模型与任务策略

当前模型能力分三层：

- `src/renderer/components/StatusBar/ModelSwitcher.tsx`：把 Engine、Model、Effort 合并到状态栏菜单，支持 Native / 外部 agent engine。
- `src/main/session/modelSessionState.ts`：支持 session 级模型 override，带 `adaptive` 标记。
- `src/main/model/adaptiveRouter.ts`：根据简单 / 中等 / 复杂任务切换 quick/free model 或提高 maxTokens。
- `src/main/model/modelRouterPolicy.ts`：有 provider fallback chain、错误分类、artifact 请求的 fallback 策略。
- `src/shared/contract/modelDecision.ts` 与 `src/renderer/components/features/chat/RouteTraceChip.tsx`：已经有模型决策事件和聊天 trace chip，能表达用户选择、角色档位、简单任务、视觉能力、可用性降级等原因。

结论：code-agent 已经有“任务策略”的技术基础，但产品语言仍偏 provider / model / effort。Alma 的 `main task model` 提醒我们要把默认模型说成“任务主模型”，并把慢、贵、降级、视觉、简单任务这些决策解释给用户。

### 3.3 Agent 与角色

当前 agent 能力分几类：

- `src/renderer/components/StatusBar/AgentSwitcher.tsx`：运行时 Agent 切换，按 builtin / user / project 分组。
- `src/renderer/components/features/settings/tabs/AgentEngineSettings.tsx`：外部 CLI Agent 引擎设置。
- `src/main/services/agentEngine/agentEngineRegistry.ts`：探测 Codex CLI / Claude Code，记录 command、permission profile、cwd policy、risk tier、audit notes。
- `src/shared/contract/builtInAgents.ts`：内置 coder / reviewer / tester / architect / debugger / documenter，支持 tools、maxIterations、modelOverride。
- `src/renderer/components/features/settings/tabs/RolesTab.tsx`：持久化角色 = 角色定义 + 角色记忆 + 工作履历。

结论：code-agent 的 agent 体系比 Alma 更复杂，但消息页没有稳定表达“本轮由哪个 agent / role / engine 影响了交付质量”。用户能切 agent，但不一定能在输出旁边看见 agent 的责任边界。

### 3.4 会话解释层

已有解释层包括：

- `src/renderer/components/ChatView.tsx` 使用 `TurnBasedTraceView` 作为主消息流。
- `src/renderer/components/features/chat/TurnCard.tsx` 从 routing evidence、capability scope、last tool、assistant text 推导 turn phase。
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx` 渲染 `RouteTraceChip`、thinking、tool call、routing evidence、hook / skill / artifact ownership。
- `src/renderer/components/features/chat/ToolStepGroup.tsx` 聚合工具步骤。
- `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails.tsx` 能展示 `MemoryCitationGroup`。
- `src/main/ipc/context.ipc.ts` 和 `src/renderer/components/TaskPanel/ContextProvenancePanel.tsx` 已有 context provenance，含 `retrieved` action 和 memory sourceType。

结论：解释层已经有能力，缺的是聚合在 assistant 输出附近的“本轮上下文与策略摘要”。现状更像调试视图，Alma 更像阅读视图。

## 4. 差异与机会

| 维度 | Alma 做法 | code-agent 现状 | 机会 |
| --- | --- | --- | --- |
| 模型选择 | 用 `main task model` 语言，把模型和任务执行绑定 | 有 ModelSwitcher、adaptive、fallback、RouteTraceChip，但语言偏技术配置 | 把默认模型改成任务主模型，把“快 / 深 / 便宜 / 视觉 / fallback”做成任务策略 |
| 记忆可解释 | retrieved / used / created / deleted 贴近消息 | pack 有 scoreReasons / evidence，injection trace 在 Knowledge 面板 | 每条 assistant 消息显示 Memory chip，展开看到 preview、score reasons、证据和纠偏动作 |
| 记忆可纠偏 | message menu 能看 used / created / deleted | 设置页可编辑、归档、删除；会话页缺直接入口 | 从消息处标记“这条不该用 / 本会话别再用 / 归档” |
| 记忆可关闭 | 会话里至少能看到是否检索 | code-agent 默认 memory_hint，active 状态可治理，但缺每个会话的显式 off | 增加 chat-level `Use memory` 开关，关闭时 messageBuild 跳过 memory_hint / seed / pack |
| Agent 影响质量 | agent 语言进入产品定位 | 有 AgentSwitcher、Agent Engine、Roles，但输出归因弱 | assistant 输出显示 active agent / engine / role memory 影响 |
| 会话质量控制 | 指标轻，用户容易理解 | trace 深，信号分散 | 做轻指标为入口，深 trace 作为展开层 |

## 5. P0 开发切片

### P0.1 每轮 Context / Strategy Strip

目标：在 assistant 输出顶部或 TurnCard header 内显示一条轻量 strip，回答“这条回复用了什么上下文、什么模型策略、哪个 agent 交付”。

建议契约：

```ts
interface TurnQualitySummary {
  memory: {
    mode: 'off' | 'hint' | 'index' | 'packed' | 'tool_search';
    trigger: string;
    selectedCount: number;
    totalCandidates?: number;
    budget?: number;
    items: Array<{
      entryId: string;
      title: string;
      scope: string;
      kind: string;
      score?: number;
      scoreReasons?: string[];
      evidence?: unknown[];
      preview: string;
      truncated?: boolean;
    }>;
  };
  strategy: {
    engine: string;
    provider: string;
    model: string;
    effort?: string;
    adaptive?: boolean;
    reason?: string;
    fallbackFrom?: string | null;
    billingMode?: string;
  };
  capabilities: {
    agentId?: string | null;
    roleId?: string | null;
    skills?: string[];
    tools?: string[];
  };
  quality: {
    warnings?: string[];
    compacted?: boolean;
    contextUsagePercent?: number;
  };
}
```

落点：

- producer：`messageBuild.ts`、`seedMemoryInjector.ts`、`memoryEntryRuntime.ts`、`memoryInjectionTrace.ts`、`modelDecision.ts`。
- projection：`turnTimelineProjection.ts` 或 message metadata。
- renderer：`TurnCard.tsx` / `TraceNodeRenderer.tsx`，先渲染 1 行 chips，tooltip 展开详情。

验收：

- 触发记忆意图的请求，assistant 输出上能看到 Memory chip，展开可见条目标题、preview、score reason、evidence。
- 无记忆命中的请求不显示“用了记忆”，最多显示 Memory available / off，不制造虚假信任。
- 模型发生 adaptive 或 fallback 时，Strategy chip 显示原因和 from / to。
- 开启 agent / role 后，输出旁能看到 agent / role 来源。
- 单测覆盖 summary producer；renderer 测试覆盖 chips、tooltip、空态；现有 trace 渲染不回退。

### P0.2 会话级 Memory 开关

目标：用户能对当前 chat 关闭记忆参与，并在消息页看见关闭状态。

建议：

- session metadata 增加 `memoryMode: 'auto' | 'off'`。
- ChatInput 或 status bar 放一个小开关，默认 auto。
- `messageBuild.ts`、`seedMemoryInjector.ts`、memory pack 入口尊重 off。
- off 时 Context / Strategy Strip 显示 `Memory off`，避免用户误以为系统没能力。

验收：

- 关闭后不注入 seed memory、memory_index、memory_hint，也不触发 memory pack。
- 关闭状态持久化到当前 session，切换会话不串。
- UI 测试覆盖开关和 chip 状态。

### P0.3 从消息处纠偏记忆

目标：用户看到“这次用错了某条记忆”时，不需要回设置页搜索。

建议：

- Memory chip detail 提供 `本会话别再用`、`归档这条`、`打开编辑` 三个动作。
- `本会话别再用` 写 session-local suppression list，不改变 durable memory。
- `归档这条` 走现有 `memoryEntryUpdate(status: archived)`，比直接删除安全。
- `打开编辑` 深链到 MemoryEntriesManager 对应 entry。

验收：

- 标记后同一 session 再问相同问题，pack 不再选该 entry。
- 归档后 entry 不再进入 active 候选。
- 错误操作可通过设置页重新激活。

### P0.4 Alma-like tools / skills / agent indicators

目标：把 auto-selected tools / skills / active agent 作为同一条 strip 的补充信号，不另起一套 UI。

建议：

- 对 tools 使用现有 `ToolStepGroup` / `ToolCallDisplay` 作为展开层。
- 对 skills 使用已有 skill activity timeline。
- 对 agent 显示 active agent、engine、role memory count。

验收：

- 自动工具选择、技能活动、外部 Agent Engine 三类场景都能在 assistant 输出附近看到入口。
- 展开后复用现有组件，不复制一套调试面板。

## 6. P1 开发切片

### P1.1 任务策略化模型设置

把设置页的模型从 provider 列表升级成任务策略：

- Main task model：默认深任务模型。
- Fast model：短问答、轻编辑、低成本路径。
- Vision model：截图、appshot、图像理解。
- Artifact model：HTML / PPT / dashboard / game 生成。
- Fallback policy：失败后如何降级。

验收重点：

- 用户不用理解 provider 细节，也能知道“这个策略会影响哪类任务”。
- 慢和贵的模型在设置页给出提示，沿用 Alma 的 `main task model` 方向。
- RouteTraceChip 能显示策略名，而不只显示 provider/model。

### P1.2 Memory Replay / Audit

把每条消息关联到 durable memory evidence：

- 记录 messageId / turnId / memory entry ids / injection trace ids。
- 生成后能打开本轮 memory audit：候选多少、选中多少、为什么选、哪些被跳过。
- created / updated memory 进入 review inbox，尤其是低 confidence 或冲突内容。

验收重点：

- 重启后仍能查看某条历史消息的 memory usage。
- 可以复现“这条回复用了哪条记忆”。
- stale / conflicting memory 有明确治理入口。

### P1.3 Agent 交付质量卡

把 agent 与质量控制接起来：

- 显示本轮 agent / role / engine / permission profile。
- 若 reviewer / tester / architect 参与，显示其贡献和最终采纳状态。
- 角色记忆更新进入可审阅队列，不自动静默污染角色。

验收重点：

- 多 agent 或外部 engine 参与时，用户能看见责任归属。
- 角色记忆新增有证据、可拒绝、可回滚。

### P1.4 会话质量评价

在轻指标基础上做自动质量检查：

- memory risk：用了 stale / low confidence / unrelated memory。
- model risk：复杂任务走了 fast model、或 fallback 到能力不足模型。
- tool risk：任务需要文件/网页/桌面证据，但没有调用对应工具。
- context risk：高上下文占用、compaction、截断。

验收重点：

- 质量提示只在有明确风险时出现。
- 每个风险都能跳到具体证据，不做泛泛提醒。
- 可接入现有 eval / replay，用真实 session 做回归。

## 7. 风险

- UI 信号过载：code-agent 已有深 trace，再叠一层 indicator 容易吵。P0 必须只显示 1 行，详情按需展开。
- 计数制造虚假信任：`retrieved 3 memories` 不等于答复可靠。chip 文案要表达“参与上下文”，不要表达“已验证正确”。
- 记忆泄露：tooltip preview 可能暴露敏感内容。需要沿用 sanitization / redaction，并限制 preview 长度。
- 纠偏误伤：直接删除 durable memory 风险高。默认用 session suppression 和 archive。
- 性能：Alma 0.0.823 专门修 main process / DB 慢路径。code-agent 若每轮都做 memory audit 持久化，必须控制写入量和索引查询成本。
- Trace 不持久：当前 `memoryInjectionTrace.ts` 是进程内数组，适合实时面板，不适合历史追责。P1 需要 durable turn linkage。
- 版本误判：旧 Alma renderer 已有 indicator，不能把它写成 0.0.823 新增点。

## 8. 推荐推进顺序

1. 做 P0.1，先把每轮 memory / model / agent 信号合成一个可见 strip。
2. 做 P0.2，让用户能在当前 chat 明确关闭 memory。
3. 做 P0.3，把“用错记忆”从设置页治理变成消息处纠偏。
4. 做 P1.1，把模型设置语言改成任务策略。
5. 做 P1.2 到 P1.4，把 explainability 升级成可复盘、可评测的质量控制。

最小闭环是 P0.1 + P0.2：用户能看到这条回复有没有用记忆、用了什么模型策略、能不能关。这个闭环上线后，P0.3 才有足够清晰的纠偏入口。

## 9. 2026-06-14 实现状态

本分支已经把研究里的 P0 与关键 P1 方向落成一条产品链路：

- 模型设置页新增任务策略卡：`fast / main / deep / vision` 四个 profile、自动/手动模式、fallback policy 和规则开关，持久化到 `settings.models.taskStrategy`。
- 自动模式路由读取同一份 task strategy：`modelDecision.ts` 产出 `strategyProfile / strategyRuleId / strategyReason / taskComplexity`，AI SDK 与 legacy `modelRouter` 路径都接入。
- 会话消息解释层升级：`TurnQualitySummary` 同时包含 memory、strategy、capabilities、score 和 agentScorecard；`TurnQualityStrip` 展示分数、策略、记忆、agent 评分卡和纠偏动作。
- Memory Replay/Audit 接入结构化 replay：assistant message metadata 里的 `turnQuality` 会转成 `memory_audit` block，telemetry replay 与 transcript fallback 都会聚合。
- 完整会话 scoring 接入 replay summary：`attachSessionQualityScoring` 聚合 turn score，生成 `summary.qualityScore` 与 `summary.agentScorecards`，供 Eval / Review / UI 后续共用。

已验证：

- `npm run typecheck`
- `npx vitest run tests/unit/model/modelDecision.test.ts tests/unit/agent/inference.modelDecision.test.ts tests/unit/model/modelRouter.test.ts tests/unit/agent/turnQuality.test.ts tests/unit/evaluation/transcriptReplayBuilder.test.ts tests/unit/evaluation/sessionQualityScoring.test.ts tests/unit/evaluation/telemetryQueryService.test.ts tests/renderer/components/traceNodeRenderer.launchRequest.test.ts tests/renderer/components/taskStrategySettingsPanel.test.tsx tests/unit/memory/memoryEntryRuntime.test.ts tests/unit/services/databaseSchema.experiments.test.ts`

### 9.1 P1 阅读界面补齐

- 右侧 workbench 新增 `Audit` tab，当前会话可打开专门的 Replay/Audit 阅读界面。
- 会话动作菜单新增 `打开 Replay/Audit` 入口，避免只能从 debug/contract 间接查看。
- 阅读界面展示 session quality score、score breakdown、agent scorecards、memory audit、tool mix 与 turn evidence。
- 每轮证据会并排显示用户输入摘要、模型策略、memory blocks、工具调用和错误信息，用于复盘“为什么这轮这么回答”。

仍需后续产品化增强：

- strategy rule builder 仍是预设规则开关，尚未开放自由条件编辑。
- 质量评分是本地 deterministic scoring，尚未接入离线 eval 校准或团队级阈值配置。
