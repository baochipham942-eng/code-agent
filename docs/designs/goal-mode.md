# /goal 模式设计（Goal Mode）

> Status: ✅ Shipped（P1-P3 已并入 main）· Owner: 林晨 · Created: 2026-05-23 · Updated: 2026-05-26 · Branch: `feat/goal-mode`（已合并）
> 本文是 /goal 功能的 SDD spec。**§0 记录 as-built 与原设计的偏差**；§1-§12 为原始设计（保留决策脉络），关键事实点已就地校准到落地实现。

## 0. 实现现状（as-built，2026-05-26 校准）

| 维度 | 落地实现 | 与原设计差异 |
|---|---|---|
| 闸1 执行器 | `src/main/agent/goalVerifyGate.ts` `runVerifyGate()` —— 直接 `spawn('/bin/sh', ['-c', verifyCommand])` parse 退出码 | ⚠️ 原设计写"Awaiter 子代理跑 verify"，as-built **不经 LLM 直接 exec**。Awaiter 是 LLM 会重新引入非确定性，违背"闸1=确定性"初衷 |
| 闸2 执行器 | `src/main/agent/goalReviewGate.ts` `runReviewGate()` —— 派 `goal-review` 子代理（强模型 `powerful` tier，带 read/grep/glob/ls 工具），要求末行输出 `VERDICT: PASS\|FAIL` | 与原设计一致（Reviewer 子代理）。去掉 bash（被子代理权限策略拦），强化 prompt 强制纯文本 verdict |
| 闸3 兜底 | `src/main/agent/goalModeController.ts` `evaluateFallback()` —— token budget / max-turns / 连续无进展（`recordTurnProgress`） | 与原设计一致 |
| 完成判定权 | `attempt_completion` 工具（goal-mode 才暴露）→ `messageProcessor` 拦截触发三层闸 | 与原设计一致 |
| `--verify` 必填性 | **verify 与 review 二选一即可**（`buildGoalContract` 校验 verify\|\|review；`GoalBodySchema` verify optional + refine）。无 verify 时跳闸1 直接进闸2 | ⚠️ 原 D1 写"verify 强制必填"，as-built **放开为软目标支持**（commit 6ab11b55），对齐自然语言目标的产品设想 |
| 终态事件 | SSE `goal_complete { status:'met'\|'aborted', reason, turns, tokensUsed }` | ⚠️ 原 §6 写 `goal_met`，as-built 统一为 `goal_complete` 带 status |
| UI | `/goal` 斜杠命令解析 + ChatInput 上方 `GoalStatusBar` 实时状态条 + `GoalNoticeMessage` 生命周期卡片；桌面 IPC + headless REST 双链路 | P3 已落地（原列为后续阶段） |
| 审计 nudge | `goalModeController.buildAuditNudge()`，每 `CHECKPOINT_INTERVAL=3` 轮注入"先假设未达成、逐项找证据反驳" | 抄 pi-goal，已落地（原列为 P2 可选增强） |

**核心模块**：`goalModeController.ts`（契约 / 闸3 / nudge / 进度）· `goalVerifyGate.ts`（闸1）· `goalReviewGate.ts`（闸2）· `messageProcessor.ts`（attempt_completion 拦截 + 闸编排）· `conversationRuntime.ts`（break→continue + loop-top 闸3）· 契约 `src/shared/contract/agent.ts`（`goal_iteration` / `goal_gate` / `goal_complete` 事件）。

**遗留（非阻塞）**：闸2 默认走 `powerful` tier（生产需代理走通海外模型，否则落默认 FAIL）；`SdkTask` 死条目；P4 swarm goal 未做。

---

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
| D1 | ~~`--verify` 强制必填~~ → **`--verify` / `--review` 二选一**（as-built 放开） | 与 Ralph "模型说完就完" 划清界限；纯软目标只给 `--review` 也能跑（commit 6ab11b55），对齐自然语言目标产品设想 |
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
│ 闸1（硬 / 确定性 / 仅 --verify 存在时）                   │
│   直接 exec goal 契约里的 --verify 命令（/bin/sh -c）     │
│   ★ as-built：不经 LLM/Awaiter 子代理（goalVerifyGate）   │
│   parse 退出码：≠0 → 真实失败输出注回上下文 → continue   │
│              =0 → 进闸2                                 │
│   ★ 不看模型脸色、不读 transcript，绕开"对话不可信"        │
│   （无 --verify 时跳过本闸，直接进闸2）                    │
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
  --verify "<shell 命令；退出码 0 即硬达成>"   ← 闸1（as-built：可选，与 --review 二选一）
  --review "<交给 Reviewer 评的软条件>"        ← 闸2（as-built：可选，与 --verify 二选一）
  --budget <token 上限>                        ← 闸3
  --max-turns <轮次上限>                       ← 闸3
```

例：`/goal 把 src/auth 测试跑通 --verify "npm test -- src/auth && npm run lint"`
纯软目标例：`/goal 把这段重构得更可读 --review "命名清晰、无重复逻辑、职责单一"`

**校验规则**：缺 `--verify` 且缺 `--review` → 拒绝启动并提示（`buildGoalContract` / `GoalBodySchema.refine`）。`--verify` 命令在 run 工作目录 `/bin/sh -c` 执行、有超时上限（`GOAL_MODE.VERIFY_TIMEOUT_MS`）。

## 5. 状态机与循环改造（钩子点，@commit a54e16e7 已核实）

| 改动点 | 文件:行 | 现状 → 目标 |
|--------|---------|------------|
| 主循环续跑 | `src/main/agent/runtime/conversationRuntime.ts:618`（text 响应 `break`） | goalMode && !goalMet → 注入审计 nudge + `continue` |
| Ralph 续跑机制 | `src/main/agent/nudgeManager.ts:623`（P0 = re-inject prompt） | 复用其注入机制承载 goal checkpoint + 审计指引 |
| 目标状态 | `src/main/agent/goalTracker.ts:22`（休眠） | 激活 + 扩字段 `verifyCommand` / `reviewCondition` / `goalStatus: pending\|met\|aborted` / `tokenBudget` / `maxTurns` / `noProgressCount` |
| 闸1 执行器 | ~~coreAgents Awaiter 子代理~~ → **新建 `src/main/agent/goalVerifyGate.ts`** | as-built：`runVerifyGate()` 直接 `/bin/sh -c` exec parse 退出码（不经 LLM，见 §0） |
| 闸2 执行器 | **新建 `src/main/agent/goalReviewGate.ts`** | `runReviewGate()` 派 `goal-review` 子代理（`powerful` tier），仅 --review 存在时 |
| 完成工具 | `src/main/tools/modules/planning/attemptCompletion.*` + `deferredTools.ts` | 净新增 `attempt_completion`，goal-mode 才预加载暴露 |
| 工具拦截 | `src/main/agent/runtime/messageProcessor.ts`（handleToolResponse） | 拦截 attempt_completion → 触发三层闸 |
| 闸编排器 | **新建 `src/main/agent/goalModeController.ts`** | GoalContract / buildGoalContract / 闸3 evaluateFallback / continuation + audit nudge / recordTurnProgress |
| 终态 | `src/main/agent/runtime/runFinalizer.ts`（RunTerminalStatus） | 加 `'goal_met'` / `'aborted'` |
| SSE 事件 | `src/shared/contract/agent.ts` + `src/web/routes/agent.ts` | 加 `goal_iteration` / `goal_gate` / `goal_complete`（见 §6） |
| 强模型路由 | `src/main/model/modelRouter.ts`（capability tier） | 闸2 调用 `powerful` tier（已实现） |

**净新增 5 样**：goal 激活入口 / `attempt_completion` 工具 / break→continue 分支 / 三层闸编排 / 终态 goal_met+aborted。

## 6. SSE 事件契约（新增）

as-built 契约见 `src/shared/contract/agent.ts`：

| 事件 | 时机 | payload（as-built） |
|------|------|---------|
| `goal_iteration` | loop-top 每轮续跑 | `{ turn, maxTurns, goalStatus, tokensUsed, tokenBudget }` |
| `goal_gate` | 闸1/闸2 判定后 | `{ gate: 1\|2, pass, exitCode?, timedOut?, reason? }` |
| `goal_complete` | 终态（原写 `goal_met`，as-built 合并为带 status） | `{ status: 'met'\|'aborted', reason?, turns, tokensUsed }` |

前端据此区分"还在跑"vs"达成"vs"被兜底中止"。注：per-turn 的 `goal_iteration` 是**新增事件**，与 §9 的 agent_complete 双发无关——后者已修（`emitAgentEvent` 终态幂等，见 §9）。

## 7. 护栏（必须放代码层）

- 每轮**强制注入** goal checkpoint + 审计指引（复用 NudgeManager 注入，模型跳不过）。
- `attempt_completion` **必定触发闸1**，模型无法"自称完成直接退出"。
- token budget / max-turns / 无进展计数 → 代码层硬停。

## 8. 现有零件复用 vs 净新增

复用（已核实存在）：循环骨架 + maxIterations、NudgeManager 注入机制、GoalTracker、Awaiter/Reviewer 子代理、modelRouter capability 路由、RunFinalizer、SSE 基础设施、deferredTools 注册。
净新增：见 §5 末。

## 9. P0 前置依赖（provider 迁移 = AI SDK 引擎，已落地 @65a61bab）

1. **Bug B**（子代理非流式丢 tool call / DeepSeek DSML）→ **已修**。迁移 commit 487e3237 子代理默认走 AI SDK 适配器（SDK 原生归一工具调用），仅 gemini 留旧路径（`AISDK_UNSUPPORTED_PROVIDERS`）。deepseek/kimi/zhipu/mimo 默认全已绕开 DSML 路径。**闸1/闸2 trust-test 解锁**（待 E2E 实证子代理工具真执行）。
2. **SSE `agent_complete` 双发**（runFinalizer + route 兜底各发一次）→ **已修**（`emitAgentEvent` 对终态幂等，PR #168）。两次都在 run() 末尾，是"两个收尾信号"非"每轮 vs 收尾混淆"，本就非 goal-mode 硬阻塞。goal-mode 的 per-turn 进度靠新增 `goal_iteration`（§6）。

**引擎架构**：AI SDK 迁移只换 contextAssembly/inference.ts 推理后端，未替换 conversationRuntime 循环 → 本设计的 loop 改动落在活跃默认路径上。
**结论**：Bug B 解锁后，"MVP 验证通过"已无前置阻塞，可推进增量3b→3e。

## 10. 分阶段实施

| 阶段 | 交付 | 状态 |
|------|------|------|
| P0 前置 | 修 Bug B + SSE 双发 | ✅ 完成（随 AI SDK 迁移 PR #168） |
| **P1 MVP** | 单 agent /goal：契约解析 + attempt_completion + break→continue + GoalTracker 激活 + 闸1 exec + 闸3 + 新 SSE 事件 | ✅ 完成（三态全 E2E：goal_met / 闸1-fail-continue / 闸3-abort） |
| P2 软闸 | 闸2 Reviewer 子代理 + 强模型路由 + Codex 式审计 nudge | ✅ 完成（FAIL/PASS 双态 E2E） |
| P3 体验 | `/goal` 斜杠命令 UI + 状态条 + 生命周期卡片 + 桌面 IPC + 软目标 | ✅ 完成（后端 + 解析器单测 + REST SSE 实证；渲染器实时点击流仅静态验证） |
| P4 swarm goal | goal 套到多 agent（MasterTask/swarm）层 | ⬜ 未做 |

## 11. 验证与 Eval

- headless webServer：`npm run dev:web:server` → `POST /api/run` SSE。
- goal-mode eval set：每条 = 目标 + verify 命令 + 期望终态（goal_met / aborted），自动判退出码。
- 成本：mimo/kimi 包月，循环本身近零成本；只管闸2 强模型那几次调用 + token budget 兜底。

## 12. 并行构建约束（历史，已解除）

> 此节是 feat/goal-mode 与 AI SDK 迁移会话并行开发期的协调护栏，两条线均已并入 main，约束失效，保留作脉络。

- goal-mode 分支曾基于 HEAD a54e16e7（不含 main 多 agent 修复），rebase 到迁移 tip 后 0 冲突。
- 当时禁编辑 `modelRouter.ts` / `providers/*` / `openaiWrapper.ts`（留给迁移会话）——现已解除。
- 闸2 调 modelRouter（P2）当时不做；迁移落地后已实现（见 §0）。
- 闸1 最终未用 Awaiter 子代理而改直接 exec（见 §0），不再依赖 Bug B 的 trust-test。
