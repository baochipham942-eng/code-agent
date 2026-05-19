# ADR-017: Plugin 化边界 — 三层 RED 分类

> 状态: proposed
> 日期: 2026-05-19

## 背景

项目自 Step 1-6 完成 builtin plugin 剥离 roadmap（7 个 plugin），Step 8 计划剥 `src/main/desktop/` 4 个 service。Step 8 base state discovery 发现 desktop 系列深度耦合 conversationRuntime 内部状态（`this.ctx.messages` / `systemPrompt` / `modelConfig`），用于动态 context pressure 计算和 token 预算决定。

第二轮全仓 audit（覆盖 `src/main/` 下所有候选 service）发现这不是 desktop 独有问题，存在多个"隐藏的 RED"：

| 服务 | 路径 | 耦合方式 |
|------|------|---------|
| desktopActivityUnderstandingService | `src/main/desktop/` | 注入 system message + token 预算 |
| workspaceActivitySearchService | `src/main/desktop/` | 同上 |
| workspaceArtifactIndexService | `src/main/desktop/` | 同上 |
| desktopActivityPlanningBridge | `src/main/desktop/` | 同上 |
| activityContextProvider | `src/main/services/activity/` | 注入 system message |
| activityPromptFormatter | `src/main/services/activity/` | 同上 |
| openchronicleContextProvider | `src/main/services/external/` | 经 activityContextProvider 间接注入 |
| lightMemory/indexLoader | `src/main/lightMemory/` | 注入 INDEX.md 到 system prompt |
| lightMemory/skillLoader | `src/main/lightMemory/` | 注入 skill block 到 system prompt |
| planningService | `src/main/planning/` | RuntimeContext 一等公民字段 |
| taskStore | `src/main/services/planning/` | agent loop 6+ 模块直接读写 |

PluginAPI v2 当前能力：仅 `registerTool` / `registerToolModule` / `registerHook`，不暴露 ContextSnapshot / planning state 给 plugin。现有 7 个 builtin plugin 全部只用 `registerToolModule`。

如果把上述 11 个 service 全部塞进"core context provider layer"作为新分类，会出现 Codex 在对抗 review 时指出的风险：**"按不能 plugin 化命名的层会变成垃圾桶，任何难剥的 service 都能进 core，plugin 化路线失去判断标准"**。

## 决策

把"不适合当前 PluginAPI v2 剥成 plugin"的 service 按**性质**拆分为三层，每层定义明确判断标准和长期归宿：

### 层 1: Prompt Context Contributors

**性质**：在 agent 每轮 turn 开始时向 system prompt 注入动态 context block。本身不持有 agent loop 控制状态。

**判断标准**：
1. 输出最终落入 `system_prompt` 或前置 system message
2. 调用时机绑定 agent turn 生命周期（session start / 每轮 user input）
3. 输出大小受 token 预算约束
4. 不参与工具调用结果或 plan 状态仲裁

**当前成员**（9 个）：

- `src/main/desktop/desktopActivityUnderstandingService.ts`
- `src/main/desktop/workspaceActivitySearchService.ts`
- `src/main/desktop/workspaceArtifactIndexService.ts`
- `src/main/desktop/desktopActivityPlanningBridge.ts`
- `src/main/services/activity/activityContextProvider.ts`
- `src/main/services/activity/activityPromptFormatter.ts`
- `src/main/services/external/openchronicleContextProvider.ts`
- `src/main/lightMemory/indexLoader.ts`
- `src/main/lightMemory/skillLoader.ts`

**长期归宿**：理论上可剥 plugin，但需要先设计 PluginAPI 扩展抽象 — 至少包含 `ContextSnapshot`（只读 messages / systemPrompt / modelConfig 投影）、`TokenBudgetView`、`PromptContributionBuilder`（结构化 contribution，runtime 负责排序/裁剪/注入）。**当前不动**，先用 Facade 收口（见 PR-1）。

### 层 2: Runtime Planning State

**性质**：agent loop 的任务状态机与协同账本，参与任务生命周期仲裁（创建 / 更新 / 完成 / 取消）。

**判断标准**：
1. 在 `RuntimeContext` 中占据一等公民字段，或被 agent loop 多个核心模块同步读写
2. 状态变更直接驱动 `onEvent` 推送（如 `todo_update` / `task_update`）
3. 被 HookManager 通过 `setBridgeHookManager` 等深度绑定接口接入

**当前成员**：

- `src/main/planning/planningService.ts`（含 planManager / hooksEngine / findingsManager）
- `src/main/services/planning/taskStore.ts`

**长期归宿**：**永久 core**，不剥 plugin。理由：plugin 一旦参与任务生命周期仲裁就越过工具层边界，权限模型、确定性、可解释性都会变重。

### 层 3: Assembly Policy

**性质**：决定 system prompt / message 序列如何组装、裁剪、压缩的策略层。本身不产生 context，但仲裁谁的 context 进、按什么顺序进、留多少 token。

**判断标准**：
1. 输入为多个 context 候选，输出为最终 prompt / messages 序列
2. 持有 token 预算/压力等全局约束
3. 决定裁剪策略（observation masking / truncate / summary）

**当前成员**：

- `src/main/agent/runtime/contextAssembly/`（messageBuild / compression 等）
- `src/main/context/tokenOptimizer.ts`

**长期归宿**：**永久 core**，不剥 plugin。理由：策略层属于 agent loop 自身控制面，剥出会让 plugin 决定 agent loop 的核心行为。

### 不属于上述三层的 service：继续走 plugin 化 roadmap

YELLOW（受 PluginAPI 缺口阻塞）与 GREEN（可立即剥）候选维持原 roadmap 方向。

## 选项考虑

### 选项 1（已采纳）: 三层分类 + 各自判断标准

- 优点：每层性质单一、有判断标准，未来新 service 可分类归位；plugin 化 roadmap 仍有清晰边界
- 缺点：ADR 体积较大，需要持续维护成员清单

### 选项 2: 统一 "core context provider layer" 单层

- 优点：简单，一句话定义
- 缺点：Codex 警告的"垃圾桶"风险 — 任何难剥的 service 都能塞进来，分类失去意义

### 选项 3: 不分层，每个 service 单独立 ADR

- 优点：决策最细
- 缺点：决策碎片化，未来无法跨 service 共享设计抽象（如 `ContextSnapshot`）

## 后果

### 积极影响

- 后续 roadmap 修订基于性质判断，不基于"能不能剥"的工程感觉
- 立即解锁 PR-1（Facade 收口）作为无 regret 改动
- 为长期"Prompt Context Contributors plugin 化"留下设计入口（ContextSnapshot 等抽象）
- ADR-005 之前的口误编号修正为 017，避免编号冲突

### 消极影响

- 三层成员清单需要 ADR 持续维护（新增 service 时归类、判断标准触发评审）
- "Prompt Context Contributors" 长期 plugin 化的设计成本被延后到有真实需要时

### 风险

- 三层边界本身可能在落地后被发现不够正交（例如某 service 横跨 contribution 和 policy）→ 缓解：每次新增成员时重新 evaluate 判断标准
- "永久 core"标记可能在未来的能力扩展中变成阻力 → 缓解：本 ADR 不限制未来推翻，但要求推翻时同步更新

## 落地动作

1. **PR-1（无 regret，立即执行）**：新建 `src/main/desktop/desktopContextBridge.ts` facade，把 conversationRuntime 对 desktop 4 个 service 的 3 个 import 收成 1 个。本 ADR 与 PR-1 同 commit。
2. **PR-1b（后续）**：把 activity / openchronicle / lightMemory 的注入 import 一并收入 facade（同性质，同一层）。
3. **GREEN 候选剥 plugin**：按 audit 报告 Top 5 顺序，screenshotPrivacyRedactor / prLinkService / captureService / cronService / doctorRunner 依次走独立 PR，验证现有 PluginAPI 是否足够。
4. **PluginAPI 扩展点**：只在剥 GREEN 时遇到真实卡点才扩，不一次性开三个口子（Codex 警告：planningHintProvider 会把 plugin 拉进 planning 层）。
5. **Prompt Context Contributors plugin 化设计**：本 ADR 不启动，需要至少一个 plugin 实际需要"贡献 context"的真实用例才触发设计阶段。

## 相关文档

- [ADR-004: 统一插件配置目录结构](./004-unified-plugin-config-structure.md)
- 审计报告: `docs/audits/2026-05-19-plugin-roadmap-audit.md`（Step 8 desktop 深度调研 + 全仓 RED 盘点 + Codex 对抗 review）
