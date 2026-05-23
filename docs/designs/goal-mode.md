# /goal 模式设计（Goal Mode）

> Status: Draft · Owner: 林晨 · Created: 2026-05-23 · Branch: `feat/goal-mode`
> 本文同时作为 /goal 功能的 SDD（Spec-Driven Development）spec 输入。

## 1. 背景与目标

`/goal` 是一类"自治循环"命令：用户给一个目标 + 完成条件，Agent 自己反复跑，每轮自判是否达成，未达成继续、达成才停，中途不需要人敲"继续"。

行业脉络：
- **源头 = Ralph Loop**（Geoffrey Huntley，2024.2 发现 / 2025 末爆火）：`while true; do cat PROMPT.md | agent; done`，用文件系统当记忆，直到模型自报 `DONE`。**死穴：字符串匹配判完成 = 模型自己批卷子。**
- **Codex /goal**（OpenAI，2026-04-30）：自审 / 上下文层——运行时**强制注入**一段"先假设没做完、逐项找证据证明"的审计提示词。审的是真状态（带工具），但被工作模型能力卡死。
- **Claude Code /goal**（Anthropic，2026-05-12）：他审 / 权重层——另起一个**无工具**小模型读对话判 yes/no。解耦干净，但**看不见现实**：模型谎称"测试通过了"它就放行。
- 参考实现 **pi-goal**（Pi = OpenClaw/龙虾 引擎，开源，Codex 式上下文注入）——上下文注入的具体写法可直接参考其源码。

**结论判断**：Agent Neo 既不照抄 Claude 的盲判卷人（本项目 transcript 不可信，见 §9 Bug B / SSE 双发），也不纯抄 Codex 自审（默认工作模型 mimo/kimi/deepseek 偏弱，自审走过场）。而是把**完成判定权落在代码层**，做"三层闸"。

## 2. 设计决策（已拍板 2026-05-23）

| # | 决策 | 理由 |
|---|------|------|
| D1 | `--verify` **强制必填** | 与 Ralph "模型说完就完" 划清界限；给不出可执行验证命令的纯软目标，强制走闸2 |
| D2 | MVP **先单 agent**，验证成功后再上 swarm goal | Ralph/Codex/Claude 都还在单循环层；swarm goal 是差异化但风险高，留 P4 |
| D3 | 交付形态 = **正式功能**（非 flag 实验） | — |
| D4 | 完成判定权在**代码层**，模型只能"申请退出" | 文章核心论点：关键约束必须从 prompt 层提升到代码层，模型绕不过 |

## 3. 核心架构：三层闸

模型调 `attempt_completion(summary)` 只是**申请退出**，不是判决，触发：

```
attempt_completion(summary)   ← 申请，非判决
        │
        ▼
┌──────────────────────────────────────────────────────┐
│ 闸1（硬 / 确定性 / 必过）                                │
│   Awaiter 子代理跑 goal 契约里的 --verify 命令           │
│   parse 退出码：≠0 → 真实失败输出注回上下文 → continue   │
│              =0 → 进闸2                                 │
│   ★ 不看模型脸色、不读 transcript，绕开"对话不可信"        │
├──────────────────────────────────────────────────────┤
│ 闸2（软 / 可选 / 仅 --review 存在时）                     │
│   Reviewer 子代理（带 bash/test 工具 + 强模型路由）       │
│   评无法落退出码的条件（设计合理性等）→ pass/fail+理由     │
│   fail → 注回 continue                                  │
│   ★ Codex/Claude 因成本默认不做，本项目包月无此约束        │
├──────────────────────────────────────────────────────┤
│ 闸3（兜底 / 纯代码层 / 永远生效）                          │
│   token budget 超 / max-turns 满 / 连续 N 轮无文件变更    │
│   → 强停，标 status='aborted'，把卡点报告给人              │
└──────────────────────────────────────────────────────┘
        │ 全过
        ▼
   finalizeRun(status='goal_met')
```

## 4. Goal 契约

```
/goal <自然语言目标>
  --verify "<shell 命令；退出码 0 即硬达成>"   ← 闸1，强制必填（D1）
  --review "<可选；交给 Reviewer 评的软条件>"   ← 闸2，可选
  --budget <token 上限>                        ← 闸3，默认值待定
  --max-turns <轮次上限>                       ← 闸3，默认值待定
```

例：`/goal 把 src/auth 测试跑通 --verify "npm test -- src/auth && npm run lint"`

**校验规则**：缺 `--verify` 且缺 `--review` → 拒绝启动并提示。`--verify` 命令在受控目录、有超时上限（复用 Awaiter 的指数退避超时）。

## 5. 状态机与循环改造（钩子点，@commit a54e16e7 已核实）

| 改动点 | 文件:行 | 现状 → 目标 |
|--------|---------|------------|
| 主循环续跑 | `src/main/agent/runtime/conversationRuntime.ts:618`（text 响应 `break`） | goalMode && !goalMet → 注入审计 nudge + `continue` |
| Ralph 续跑机制 | `src/main/agent/nudgeManager.ts:623`（P0 = re-inject prompt） | 复用其注入机制承载 goal checkpoint + 审计指引 |
| 目标状态 | `src/main/agent/goalTracker.ts:22`（休眠） | 激活 + 扩字段 `verifyCommand` / `reviewCondition` / `goalStatus: pending\|met\|aborted` / `tokenBudget` / `maxTurns` / `noProgressCount` |
| 闸1 执行器 | `src/main/agent/hybrid/coreAgents.ts:118`（Awaiter 子代理） | 派 Awaiter 跑 verify 命令、parse 退出码 |
| 闸2 执行器 | `src/main/agent/hybrid/coreAgents.ts:199`（Reviewer 子代理） | 仅 --review 存在时派发，强模型路由 |
| 完成工具 | `src/main/services/toolSearch/deferredTools.ts`（CORE_TOOLS） | 净新增 `attempt_completion`，goal-mode 才暴露 |
| 工具拦截 | `src/main/agent/runtime/messageProcessor.ts`（handleToolResponse） | 拦截 attempt_completion → 触发三层闸（⚠️ 该文件 main 上有未提交改动，合并时注意） |
| 终态 | `src/main/agent/runtime/runFinalizer.ts:122`（RunTerminalStatus） | 加 `'goal_met'` / `'aborted'` |
| SSE 事件 | `src/web/routes/agent.ts:310` | 加 `goal_iteration` / `goal_met` 事件（见 §7） |
| 强模型路由 | `src/main/model/modelRouter.ts:155`（selectModelByCapability） | 闸2 调用（**P2 才做，本会话不碰此文件**） |

**净新增 5 样**：goal 激活入口 / `attempt_completion` 工具 / break→continue 分支 / 三层闸编排 / 终态 goal_met+aborted。

## 6. SSE 事件契约（新增）

| 事件 | 时机 | payload |
|------|------|---------|
| `goal_iteration` | 每轮 goal-mode 续跑时 | `{ iteration, goalStatus, completed[], failed[], budgetUsed }` |
| `goal_gate` | 闸1/闸2 判定后 | `{ gate: 1\|2, pass: bool, reason }` |
| `goal_met` | 三闸全过 | `{ summary, iterations, budgetUsed }` |

前端据此区分"还在跑"vs"达成"vs"被兜底中止"。注：per-turn 的 `goal_iteration` 是**新增事件**，与 §9 的 agent_complete 双发无关（后者是两个收尾信号，非阻塞）。

## 7. 护栏（必须放代码层）

- 每轮**强制注入** goal checkpoint + 审计指引（复用 NudgeManager 注入，模型跳不过）。
- `attempt_completion` **必定触发闸1**，模型无法"自称完成直接退出"。
- token budget / max-turns / 无进展计数 → 代码层硬停。

## 8. 现有零件复用 vs 净新增

复用（已核实存在）：循环骨架 + maxIterations、NudgeManager 注入机制、GoalTracker、Awaiter/Reviewer 子代理、modelRouter capability 路由、RunFinalizer、SSE 基础设施、deferredTools 注册。
净新增：见 §5 末。

## 9. P0 前置依赖（provider 迁移 = AI SDK 引擎，已落地 @65a61bab）

1. **Bug B**（子代理非流式丢 tool call / DeepSeek DSML）→ **已修**。迁移 commit 487e3237 子代理默认走 AI SDK 适配器（SDK 原生归一工具调用），仅 gemini 留旧路径（`AISDK_UNSUPPORTED_PROVIDERS`）。deepseek/kimi/zhipu/mimo 默认全已绕开 DSML 路径。**闸1/闸2 trust-test 解锁**（待 E2E 实证子代理工具真执行）。
2. **SSE `agent_complete` 双发**（runFinalizer.ts:286 + agent.ts:965，emitAgentEvent 不去重）→ **未修**（迁移没碰）。但两次都在 run() 末尾（早发解 UI loading + persist 后再发），是"两个收尾信号"非"每轮 vs 收尾混淆"——**不是 goal-mode 硬阻塞**，降级为幂等性小清理。goal-mode 的 per-turn 进度靠新增 `goal_iteration`（§6/增量3e）。

**引擎架构**：AI SDK 迁移只换 contextAssembly/inference.ts 推理后端，未替换 conversationRuntime 循环 → 本设计的 loop 改动落在活跃默认路径上。
**结论**：Bug B 解锁后，"MVP 验证通过"已无前置阻塞，可推进增量3b→3e。

## 10. 分阶段实施

| 阶段 | 交付 | 依赖 |
|------|------|------|
| P0 前置 | 修 Bug B + SSE 双发 | provider 迁移落地 |
| **P1 MVP** | 单 agent /goal：契约解析 + attempt_completion + break→continue + GoalTracker 激活 + 闸1 编排 + 闸3 + 新 SSE 事件脚手架 | — |
| P2 软闸 | 闸2 Reviewer + 强模型路由 + Codex 式审计 nudge（抄 pi-goal） | P1 + provider 迁移 |
| P3 体验 | UI 进度态、中途 steer/pause、token 实时显示 | P2 |
| P4 swarm goal | goal 套到多 agent（MasterTask/swarm）层 | P1 验证通过 |

## 11. 验证与 Eval

- headless webServer：`npm run dev:web:server` → `POST /api/run` SSE。
- goal-mode eval set：每条 = 目标 + verify 命令 + 期望终态（goal_met / aborted），自动判退出码。
- 成本：mimo/kimi 包月，循环本身近零成本；只管闸2 强模型那几次调用 + token budget 兜底。

## 12. 并行构建约束（与 provider 迁移会话并行）

- 本分支基于已提交 HEAD a54e16e7，**不含 main 上未提交的多 agent 修复**（messageProcessor/subagentExecutor/bootstrap/database）；合并时 messageProcessor.ts 需留意（双方改不同代码块，多半可自动合并）。
- 本会话**禁止编辑** `modelRouter.ts` / `src/main/model/providers/*` / `openaiWrapper.ts`（留给迁移会话）。
- 闸2 + 强模型路由（调 modelRouter）= P2，**本会话不做**。
- 闸1 Awaiter 编排可建，但**不能 trust-test**（依赖 Bug B 修复），先接线标 `verification-blocked`。
