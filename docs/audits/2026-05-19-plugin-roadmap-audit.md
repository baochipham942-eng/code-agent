# Plugin 化 Roadmap 全仓 Audit

**日期**: 2026-05-19
**触发**: Step 8 (desktop 4 service 剥 plugin) base state discovery 发现 agent loop 硬依赖，roadmap 前提失效
**输入**: 2 轮 Claude code-explorer 调研 + 1 轮 Codex 对抗 review
**产出**: ADR-017（三层 RED 分类）+ PR-1（Facade 收口）+ roadmap v2

---

## 0. 调研结论一句话

11 个 service 被发现"不适合按当前 PluginAPI v2 剥 plugin"，但它们性质各异 — 拆成三层比统一叫 "core context provider" 更稳，避免新层变成"难剥就塞进来"的垃圾桶。

---

## 1. 第一轮：Step 8 desktop 深度调研

### 1.1 调研范围

`src/main/desktop/` 下 4 个 service：
- `desktopActivityUnderstandingService.ts`（40K）
- `workspaceActivitySearchService.ts`（20K）
- `workspaceArtifactIndexService.ts`（26K）
- `desktopActivityPlanningBridge.ts`（6.2K）

### 1.2 硬依赖网络（精确位置）

| 调用方 | 位置 | 调用什么 |
|--------|------|---------|
| agent loop turn | `src/main/agent/runtime/conversationRuntime.ts:1151` → `bootstrapDesktopDerivedContext()` | 进入 desktop 集成链 |
| desktop 数据拉取 | `conversationRuntime.ts:247-248` | `getDesktopActivityUnderstandingService().ensureFreshData(2min)` |
| todo 同步 | `conversationRuntime.ts:281` | `syncTodoCandidatesToTasks(sessionId, ...)` |
| planning 同步 | `conversationRuntime.ts:306` | `syncDesktopTasksToPlanningService(planningService, tasks)` |
| context 注入 | `conversationRuntime.ts:344` | `buildWorkspaceActivityContextBlock(userMessage, { contextMaxTokens, contextMaxItems })` |
| planning tool | `src/main/tools/modules/planning/taskUpdate.ts:139-191` | `recordTodoFeedbackForTask` (best-effort) |
| planning tool | `src/main/tools/modules/planning/planUpdate.ts:165-202` | `recordTodoFeedbackForTask` / `recordWorkspaceActivityFeedback` (best-effort) |
| 后台启动 | `src/main/app/initBackgroundServices.ts:475,481` | `initDesktopActivityUnderstandingService` + `initWorkspaceArtifactIndexService` |

### 1.3 关键不能剥点

`bootstrapDesktopDerivedContext`（conversationRuntime.ts:248-:400）在调用 `buildWorkspaceActivityContextBlock` 前**计算 context pressure**（:326-:341），依赖：
- `this.ctx.systemPrompt`
- `this.ctx.persistentSystemContext`
- `this.ctx.messages`（过滤 role === 'system'）
- `this.ctx.modelConfig.model`

这些状态 PluginAPI v2 不暴露给 plugin。若强行 plugin 化，必须新增 `ContextSnapshot` / `TokenBudgetView` 类抽象（属于"plugin 系统能力扩展"，不是简单的工具注册）。

### 1.4 PluginAPI v2 现状

仅暴露 `registerTool` / `registerToolModule` / `registerHook`。Step 1-6 剥的 7 个 builtin plugin 全部只用 `registerToolModule`。HookManager 是配置文件驱动（用户脚本/HTTP），不是 main 进程 service 注册容器。

---

## 2. 第二轮：全仓 RED 盘点

### 2.1 评分标准（每维 0-3 分）

- **Dim 1 Agent Loop 耦合度**：3 = conversationRuntime 直接 import 且依赖内部状态
- **Dim 2 Context Provider 性质**：3 = 主动构造 system message 注入 agent prompt
- **Dim 3 PluginAPI 兼容度**：3 = 现有 ToolModule 范式即可承载

### 2.2 RED 候选（不适合剥 plugin）

11 个：

| Service | 路径 | 主要 RED 维度 |
|---------|------|--------------|
| desktopActivityUnderstandingService | `src/main/desktop/` | Dim 2=3, Dim 1=3 |
| workspaceActivitySearchService | `src/main/desktop/` | Dim 2=3, Dim 1=3 |
| workspaceArtifactIndexService | `src/main/desktop/` | Dim 2=3（被 search 消费）|
| desktopActivityPlanningBridge | `src/main/desktop/` | Dim 2=3 |
| activityContextProvider | `src/main/services/activity/` | Dim 1=3, Dim 2=3 |
| activityPromptFormatter | `src/main/services/activity/` | Dim 2=2 |
| openchronicleContextProvider | `src/main/services/external/` | Dim 1=3（间接） |
| lightMemory/indexLoader | `src/main/lightMemory/` | Dim 1=2, Dim 2=2 |
| lightMemory/skillLoader | `src/main/lightMemory/` | Dim 1=2, Dim 2=2 |
| planningService | `src/main/planning/` | Dim 1=3（RuntimeContext 一等公民） |
| taskStore | `src/main/services/planning/` | Dim 1=3（6+ agent loop 模块读写） |

### 2.3 GREEN Top 5（适合剥 plugin）

| 排名 | Service | 价值 | 工程量 |
|------|---------|------|--------|
| 1 | screenshotPrivacyRedactor | 纯图片处理，可融入 computerUse plugin | 1 PR / 3 文件 |
| 2 | prLinkService（GitHub） | GitHub PR context 拉取工具 | 1 PR / 4 文件 |
| 3 | captureService（knowledge） | 浏览器采集 + 向量化 | 1-2 PR / 5 文件 |
| 4 | cronService + heartbeatService | 定时任务管理 | 2 PR / 6 文件 |
| 5 | diagnostics/doctorRunner | 环境健康检查 | 1 PR / 4 文件 |

### 2.4 YELLOW 候选（被 PluginAPI 缺口卡住）

- `citationService` / `diffTracker` / `gitStatusService` → 需 `onAfterToolCall` lifecycle hook
- `fileWatcherService` → 需 pre-tool-batch hook
- `toolSearchService` → 需 `toolRegistryProvider` 扩展点
- `taskOrchestrator` → 需 `planningHintProvider` 扩展点（**Codex 警告：危险，会把 plugin 拉进 planning 层**）

---

## 3. 第三轮：Codex 对抗 review

### 3.1 最强反驳

> 把"当前 PluginAPI 拿不到 runtime 状态"直接推成"这类能力不该 plugin 化"是 lazy。深度耦合不等于天然 core，它也可能说明缺一层受控依赖注入。比如 plugin 不直接读 `ctx.messages`，而是拿到只读的 `ContextSnapshot`、`TokenBudgetView`、`SessionIdentity`、`PromptContributionBuilder`。

**修正**：RED 不应单层处理。**desktop / activity / lightMemory / openchronicle** 这类是 *Prompt Context Contributors*，理论上可剥 plugin（需新抽象）；**planningService / taskStore** 是 *Runtime Planning State*，参与任务生命周期仲裁，**永久 core**；**token pressure / context assembly** 是 *Assembly Policy*，**永久 core**。

### 3.2 关键风险信号

> "core context provider layer" 如果只按"不能 plugin 化"命名，本质上会变成垃圾桶。以后任何难剥的 service 都能进 core，plugin 化路线会失去判断标准。

**应对**：ADR-017 明确写 3 层的判断标准，新增成员必须触发标准评审。

### 3.3 优先级倒置警告

> 先扩 `onAfterToolCall / toolRegistryProvider / planningHintProvider`，容易为了 YELLOW 一次性设计三个抽象，但还没有足够 plugin 用例证明这些口子形态正确。`planningHintProvider` 尤其危险，它会把 plugin 从工具发现层拉进 planning 层。

**应对**：先剥 GREEN 验证现有 PluginAPI 是否足够，YELLOW 只挑 citation/diff 做一个 `toolResultObserver` 最小试点，**不同时开三个口子**。

### 3.4 Codex 同意的部分

- Step 8 不按原计划硬剥（共识）
- planningService / taskStore 永久 core（理由从"context provider"修正为"orchestration state"）
- ADR 必须立，但要写清三层边界，不能只命名"core context provider layer"

---

## 4. Roadmap v2

| 步骤 | 内容 | 状态 |
|------|------|------|
| ADR-017 | 三层 RED 分类 + 判断标准 | ✅ 本次 commit |
| PR-1 | `desktopContextBridge` Facade 收 conversationRuntime 3 个 desktop import | ✅ 本次 commit |
| PR-1b | 把 activity / openchronicle / lightMemory 注入 import 一并收入 facade | 待开 |
| PR-2 | 剥 GREEN Top 1（screenshotPrivacyRedactor） | 待开 |
| PR-3 ~ PR-6 | 依次剥 GREEN Top 2-5 | 待开 |
| PR-N | 真有需要再扩 `toolResultObserver`（最小扩展） | 看 PR-2~6 结果 |
| 远期 | 设计 `ContextSnapshot + registerContextContributor` 解锁 Prompt Context Contributors 层 | 暂不启动 |

---

## 5. 附：4 个 desktop service 的归宿（细化）

- 物理路径仍在 `src/main/desktop/`，无迁移成本
- 类型归属：**Prompt Context Contributors 层**（ADR-017 第 1 层）
- 长期可剥 plugin 条件：PluginAPI 暴露 `ContextSnapshot` + `PromptContributionBuilder`
- 当前接入点收口：`src/main/desktop/desktopContextBridge.ts`（本次新建）
- 调用方迁移：`conversationRuntime.ts` 已迁；`taskUpdate.ts` / `planUpdate.ts` 的 best-effort 调用维持原状（不在本 PR 范围，Step 8 调研结论：失败不阻断，独立性高）

---

## 6. 相关文档

- [ADR-017: Plugin 化边界 三层 RED 分类](../decisions/017-plugin-boundary-three-layers.md)
- 调研原始报告：本会话 context 中保留（feature-dev:code-explorer 两次调研 + codex exec adversarial review）
