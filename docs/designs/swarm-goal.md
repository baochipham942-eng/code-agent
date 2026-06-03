# Swarm Goal（P4）+ 主动性合流 设计方案

> 状态：设计定稿（2026-06-03 与林晨拍板 5 决策），待实现
> 日期：2026-06-03
> 上游：[goal-mode.md](goal-mode.md) §10 P4 预留 / [role-proactivity.md](role-proactivity.md) / [dynamic-workflow.md](../architecture/dynamic-workflow.md)
> 前置依赖：PR #207（角色主动性）+ PR #208（goal 收尾）已于 2026-06-03 合并
> 分支：`feat/swarm-goal`（基于 origin/main `0728ee251`）

---

## 1. 背景与定位

### 1.1 要解决的问题

goal 模式（/goal 三层闸，已 SHIPPED）目前只能套**单 agent**：一个 agent 循环推进直到三层闸判定完成。对于天然可并行的大目标（"把 30 个测试文件全修绿"、"给 5 个模块各写一份文档"），单 agent 串行干是浪费——这正是设计文档里明确留到 P4 的差异化能力。

同时这是与**角色主动性**（PR #207）的合流点：角色醒来决策"推进 advance"时，目前只是在 15 轮预算内随便干干、自己说做完就做完——没有完成判定。合流后，推进 = 立一个带验收标准的正式目标，干完必须过验证闸才算数。

### 1.2 两个功能点

| # | 功能点 | 定位 |
|---|--------|------|
| ① | goal 内 swarm 执行 | P4 本体：goal 主 agent 可经 workflow 工具扇出多 agent 并行，消耗计入 goal 预算 |
| ② | 主动性 advance → goal run | 合流：角色推进升级为带完成判定的单 agent goal run |

---

## 2. 拍板决策记录（2026-06-03 与林晨确认）

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 底座选型 | **dynamic-workflow（scriptRuntime）** | 预算追踪（BudgetTracker）/ provider 感知并发闸 / 断点恢复 / 串行写护栏四件套全现成；子 agent 中间结果不灌主上下文；本来就是为大规模并行子 agent 设计 |
| 2 | goal 分解 | **共享单 goal**，分解交给编排脚本 | goal 契约 / SSE 事件 / UI 状态条全不动；模型在脚本里自主拆工作、可自己给子任务写验证 stage；新增概念最少、防设计膨胀 |
| 3 | 三层闸位置 | **整体级**（attempt_completion → 闸1/2/3 原样跑） | 子任务质量检查由编排脚本自己写（对抗验证 stage 等模式），不进契约 |
| 4 | 主动性合流 | **advance → 单 agent goal run**，不开 swarm 入口 | 让"角色主动推进"第一次有完成判定（合流的核心价值）；无人监督不扇出，防烧 token |
| 5 | MVP 切口 | **先①后②、都进本期**，独立 commit + 独立 E2E | ①是 P4 本体必须先落地；②在①地基上是薄接线（AgentRunOptions.goal / cli config.goalContract 入口已存在）；②做不完可砍 |

---

## 3. 核心架构

### 3.1 功能点①：goal 内 swarm 执行

```
/goal <目标> --verify "..." --budget N
        │
        ▼
goal 主 agent（conversationRuntime 循环，不动）
        │
        ├─ 模型判断任务可并行 → 调 workflow 工具，当场写编排脚本
        │        │
        │        ▼
        │   scriptRuntime 扇出 N 个子 agent
        │   （ConcurrencyGate / SerialWriteGate / BudgetTracker 全现成）
        │        │
        │        ▼
        │   脚本 return 最终结果 → 回到主 agent
        │   meta.tokensSpent → goalMode.recordSwarmTokens()  ★ 上行记账
        │
        ├─ 模型继续推进 / 调 attempt_completion 申请退出
        ▼
三层闸（完全不动）：
  闸1 verify exec → 闸2 review 子代理 → 闸3 预算兜底（含 swarm 消耗 ★）
```

**三个接线点**（净新增极少，全是在现有模块上开口）：

| 接线点 | 现状 | 改动 |
|--------|------|------|
| 工具预加载 | goal mode 只预加载 attempt_completion（`deferredToolPreload.ts:48-50`）；workflow 工具按用户意图正则才预加载（`:68-70`） | goal mode 且 `contract.allowSwarm` 时同时预加载 `workflow` |
| 编排引导 | goal system prompt（`goalModeController.ts` `buildGoalSystemPrompt`）无 swarm 指引 | 加一段：目标可并行时可用 workflow 工具扇出；预算自动受限于 goal 剩余预算；子任务建议带验证 stage（决策 #3 软约束） |
| 预算双向打通 | 下行：workflow `budgetTokens` 由模型自报，不可信。上行：子 agent 消耗不计入 `tokensUsed`，闸3 看不见（`conversationRuntime.ts:472` 只算主 agent token） | 见 §4，本设计的核心工程量 |

### 3.2 功能点②：主动性 advance → goal run

```
角色醒来（wakeRole 八步循环，不动）
        │
        ▼ 步骤 5 解析决策（roleProactivity.ts parseWakeDecision）
<decision>advance</decision> + <goal>提案</goal>（新增标记，可选 <verify>）
        │
        ▼
launchAdvanceGoalRun()（roleProactivity 内部新增）
   ├─ Electron 路径：orchestrator.sendMessage(goalPrompt, undefined, { goal: {...} })
   │     ← AgentRunOptions.goal 已存在（research/types.ts:175），零改动直接用
   └─ headless 路径：config.goalContract = buildGoalContract({...})
         ← cli/bootstrap.ts:429 已支持，零改动直接用
        │
        ▼
单 agent goal run（allowSwarm=false → 不预加载 workflow，无人值守不扇出）
        │
        ▼
三层闸判定 → 履历记录 met/aborted + 完成证据
```

**醒来 prompt 的 advance 指令升级**（roleProactivity.ts `buildWakePrompt`）：

```
【推进 advance】产物有明确的下一步且你能独立完成：
  - 一步就能做完 → 直接做，做完汇报（现状不变）
  - 需要多步推进（修复+验证、重构+测试等）→ 不要自己动手，输出目标提案：
      <goal>要达成什么</goal>
      <verify>验收用的 shell 命令（可选，能写就写）</verify>
    系统会为这个提案发起一个带完成判定的正式 goal run。
```

**两阶段语义**：醒来实例 = 侦察兵（便宜，15 轮内判断要不要推进、推进什么），goal run = 执行者（带闸，干完必须过验证）。这与主动性设计的"持久的是资产，瞬时的是实例"一致——goal run 也是一个瞬时实例，结果写回履历。

---

## 4. 预算护栏（一等公民）

> swarm goal 的消耗 = 单 goal × N 个子 agent。预算不是附加项，是架构的一部分。

### 4.1 双向打通（功能点①的核心工程量）

| 方向 | 缺口（as-is） | 设计（to-be） | 落点 |
|------|--------------|--------------|------|
| **下行**：goal → workflow | workflow 的 `budgetTokens` 参数由模型在工具调用里自报——模型可以不传或乱传，绕过 goal 预算 | messageProcessor 在 goal mode 下**拦截 workflow 工具调用**（与 attempt_completion 拦截同位置 `messageProcessor.ts:574`），在 dispatch 前把 `budgetTokens` clamp 到 `min(模型自报值, goal 剩余预算 × MAX_BUDGET_FRACTION)`。剩余预算 = tokenBudget − 主 agent 消耗 − 已记账 swarm 消耗 | `messageProcessor.ts` handleToolResponse |
| **上行**：workflow → 闸3 | workflow 子 agent 的消耗只活在 scriptRuntime 的 BudgetTracker 里，**不汇入主 run 的 tokensUsed**（`conversationRuntime.ts:472`），闸3 对 swarm 消耗失明 | workflow 工具结果已带 `meta.tokensSpent`（成功/失败路径都有，`workflow.ts` 返回值）→ messageProcessor 在工具结果回来后调 `goalMode.recordSwarmTokens(meta.tokensSpent)` → 闸3 `evaluateFallback` 和 SSE `goal_iteration` 的 tokensUsed 都计入 swarm 消耗 | `messageProcessor.ts` + `goalModeController.ts` |

### 4.2 GoalContract 扩展（唯一的契约改动）

```typescript
export interface GoalContract {
  // ……现有字段全部不动（goal / verifyCommand / reviewCondition / tokenBudget / maxTurns）
  /**
   * 是否允许 swarm 扇出（控制 workflow 工具预加载 + 预算注入）。
   * 交互式 /goal 默认 true；主动性 advance 发起的 goal run 强制 false（无人值守不扇出）。
   */
  allowSwarm?: boolean;
}
```

### 4.3 常量（新增 `SWARM_GOAL` 块，进 `src/shared/constants/agent.ts`，与 `GOAL_MODE` 相邻）

```typescript
export const SWARM_GOAL = {
  /** 单次 workflow 扇出预算占 goal 剩余预算的最大比例（留余量给主 agent 收尾 + 闸2 评审） */
  MAX_BUDGET_FRACTION: 0.8,
  /** advance 发起的 goal run 默认 token 预算（远小于交互式 /goal 的 2M 默认值） */
  ADVANCE_GOAL_TOKEN_BUDGET: 200_000,
  /** advance 发起的 goal run 默认轮次上限 */
  ADVANCE_GOAL_MAX_TURNS: 30,
  /** advance 目标提案标记提取正则 */
  GOAL_TAG_PATTERN: /<goal>([\s\S]*?)<\/goal>/i,
  /** advance 验收命令提案标记提取正则 */
  VERIFY_TAG_PATTERN: /<verify>([\s\S]*?)<\/verify>/i,
} as const;
```

### 4.4 护栏总览（分层防御）

| 护栏 | 层级 | 谁挡 | 状态 |
|------|------|------|------|
| goal token 预算（含 swarm 消耗） | goal run 整体 | 闸3 `evaluateFallback` | 本期打通上行记账 |
| 单次扇出预算 ≤ 剩余预算 × 0.8 | 单次 workflow 调用 | messageProcessor clamp | 本期新增 |
| workflow 内部预算硬上限 | scriptRuntime | `BudgetTracker.reserveOrThrow` | 现成 |
| provider 并发上限 | scriptRuntime | `ConcurrencyGate` | 现成 |
| 并行写冲突 | scriptRuntime | `SerialWriteGate` | 现成 |
| advance goal run 预算 | 角色主动性 | `ADVANCE_GOAL_*` 常量 | 本期新增 |
| 每角色每日醒来上限 | 角色主动性 | `MAX_WAKES_PER_DAY=4` | 现成 |
| advance goal run 禁 swarm | 嵌套防爆 | `allowSwarm=false` | 本期新增 |
| advance goal run 防递归触发 event 醒来 | 角色主动性 | 醒来会话 origin 标记（现有防递归机制扩展） | 本期确认覆盖 |

---

## 5. 技术接入点清单

### 功能点①：goal 内 swarm 执行

| 模块 | 改动 | 文件 | 新建/修改 |
|------|------|------|----------|
| 契约 | `GoalContract` 加 `allowSwarm?: boolean`；`buildGoalContract` 透传（默认 true） | `src/main/agent/goalModeController.ts` | 修改 |
| 常量 | `SWARM_GOAL` 块 | `src/shared/constants/agent.ts` | 修改 |
| 工具预加载 | goal mode 且 allowSwarm → 预加载 `workflow` | `src/main/agent/runtime/contextAssembly/deferredToolPreload.ts` | 修改 |
| 编排引导 | goal system prompt 加 swarm 指引段（仅 allowSwarm 时） | `src/main/agent/goalModeController.ts` | 修改 |
| 预算下行 | goal mode 下拦截 workflow 调用 → clamp budgetTokens | `src/main/agent/runtime/messageProcessor.ts` | 修改 |
| 预算上行 | workflow 结果 meta.tokensSpent → `recordSwarmTokens()` | `src/main/agent/runtime/messageProcessor.ts` + `goalModeController.ts` | 修改 |
| 闸3 计入 | `evaluateFallback` / `goal_iteration` 的 tokensUsed 加 swarm 消耗 | `src/main/agent/goalModeController.ts` + `runtime/conversationRuntime.ts` | 修改 |
| 入口透传 | desktop（agentOrchestrator）/ web（routes/agent.ts）的 goal 入参支持 allowSwarm（可选，默认 true） | `src/main/agent/agentOrchestrator.ts` + `src/web/routes/agent.ts` + `src/shared/contract/appService.ts` | 修改 |

### 功能点②：advance → goal run

| 模块 | 改动 | 文件 | 新建/修改 |
|------|------|------|----------|
| 醒来 prompt | advance 指令升级：多步推进输出 `<goal>`/`<verify>` 提案 | `src/main/services/roleAssets/roleProactivity.ts` | 修改 |
| 提案解析 | `parseGoalProposal()`：从醒来输出提取 goal/verify 标记 | `src/main/services/roleAssets/roleProactivity.ts` | 修改 |
| goal run 发起 | `launchAdvanceGoalRun()`：双路径发起单 agent goal run（orchestrator options.goal / cli config.goalContract），`allowSwarm=false` + `ADVANCE_GOAL_*` 预算 | `src/main/services/roleAssets/roleProactivity.ts` | 修改 |
| 防递归 | advance goal run 的会话不再触发 event 醒来（确认现有 origin 标记机制覆盖此路径） | `src/main/agent/runtime/runFinalizer.ts`（确认即可，预期零改动） | 确认 |
| 履历写回 | goal run 终态（met/aborted + 证据摘要）写回角色履历 | `src/main/services/roleAssets/roleProactivity.ts` | 修改 |
| 常量 | `ADVANCE_GOAL_*` 已含在 SWARM_GOAL 块 | `src/shared/constants/agent.ts` | （同①） |

---

## 6. MVP 范围

**做**：

1. 功能点①三接线点 + 预算双向打通（§3.1 + §4.1）
2. 功能点② advance → 单 agent goal run（§3.2）
3. SWARM_GOAL 常量块 + GoalContract.allowSwarm
4. E2E 验收脚本（§7）

**不做（明确边界，防设计膨胀）**：

- ❌ 子 goal DAG / 子级闸（决策 #2/#3 已排除；如未来需要，编排脚本内的验证 stage 模式已可覆盖大部分场景）
- ❌ advance → swarm goal（决策 #4 已排除；无人值守不扇出）
- ❌ goal 分解的专属 UI（workflow 进度树 / GoalStatusBar 现成 UI 已够用，swarm 进度走现有 WorkflowInlineMonitor）
- ❌ 多角色协同 goal（A 角色的 goal run 调用 B 角色）
- ❌ P0-2 项目空间维度的持久 goal（交接 brief 明确：本期不揽）
- ❌ workflow 编排脚本的 goal 专属模板/skill（先靠 prompt 引导，效果不好再做）

---

## 7. E2E 验收标准

脚本：`scripts/acceptance/swarm-goal-e2e.ts`（参考 `role-proactivity-e2e.ts`：假 HOME 隔离 + webServer headless + 真实模型 xiaomi/mimo 直连）

| # | 场景 | 验证方式 | 成本 |
|---|------|---------|------|
| AC1 | goal mode（allowSwarm=true）下 workflow 工具被预加载；allowSwarm=false 时不预加载 | 确定性（检查 run 的工具列表/SSE 事件） | 零模型成本 |
| AC2 | goal run 内模型用 workflow 扇出 → 子 agent 消耗计入 goal tokensUsed → `goal_iteration`/`goal_complete` 事件的 tokensUsed 包含 swarm 消耗 | 真实模型全链路 | mimo 包月 |
| AC3 | 预算下行 clamp：goal 剩余预算不足时 workflow budgetTokens 被压到剩余 × 0.8 | 单测确定性覆盖（messageProcessor clamp 逻辑） | 零模型成本 |
| AC4 | advance → goal run：预埋产物 → 角色醒来 → advance + goal 提案 → 发起 goal run → 过闸 → 履历记录 met/aborted | 真实模型全链路 | mimo 包月 |
| AC5 | advance goal run 禁 swarm：AC4 发起的 goal run 中 workflow 工具不可用 | 确定性（检查工具列表） | 零模型成本 |

单测：`tests/unit/agent/swarmGoal.test.ts`（clamp 计算 / recordSwarmTokens 记账 / 提案解析 / allowSwarm 默认值）

---

## 8. 风险与开放问题

| 风险 | 应对 |
|------|------|
| 模型在 goal 循环里滥用 workflow（小任务也扇出，浪费） | prompt 引导写明"只有天然可并行的目标才扇出"；MAX_BUDGET_FRACTION 限制单次消耗；闸3 兜底 |
| workflow 子 agent 改文件与主 agent 改文件冲突 | scriptRuntime 现成 SerialWriteGate（run 内）+ WriteIsolationManager（跨工具）兜底；E2E 验证 |
| mimo 等弱模型写不好编排脚本（脚本语法错） | workflow 工具的 validateScript 主线程 fail-fast 会把错误注回，模型可重写；goal 循环天然容忍多轮试错 |
| advance 提案质量差（goal 写得太模糊 / verify 命令写错） | verify 命令跑不通 = 闸1 fail = goal run 多轮修复直到预算耗尽 aborted；履历记录 aborted 原因，沉默率高的角色用户自然会调低频率 |
| 醒来实例 + goal run 两段消耗叠加 | ADVANCE_GOAL_TOKEN_BUDGET=200K 远小于交互式默认 2M；每日醒来 4 次上限不变；goal run 计入当天预算统计 |
| workflow 工具结果 meta 字段缺失（异常路径） | recordSwarmTokens 对 undefined/NaN 防御性跳过，记账缺失不影响 goal 主流程（只是闸3 少算，仍有 maxTurns 兜底） |

---

## 9. 实现纪律

- 独立 worktree `feat/swarm-goal`，所有文件操作用 worktree 绝对路径
- 禁止硬编码：所有数值进 `SWARM_GOAL` 常量块
- 每个功能点 typecheck + 独立 commit，不跑全量 vitest
- commit 不 push；E2E 验收报告给林晨后再决定 push + PR
