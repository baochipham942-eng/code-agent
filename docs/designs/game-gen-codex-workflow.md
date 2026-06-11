# 游戏生成 Codex 式工作流改造（Game-Gen Codex Workflow）

> Status: 📝 Draft（方案评审中）· Owner: 林晨 · Created: 2026-06-11 · Branch: `worktree-game-gen-codex-style`
> 本文是游戏生成**生成侧工作流**的改造方案。与 `docs/audits/2026-05-07-game-acceptance-architecture.md`（验收侧架构审计，已定 Phase 0-4 迁移计划）互补：审计解决"怎么判卷"，本方案解决"怎么答题"。验收侧的硬规则（§7 Hard Rules：repair 硬上限 2 轮、monotonicity gate、BoN=3、minimum-diff prompt 等）本方案全部继承，不重新发明。

## 0. 问题陈述（为什么现在的生成方式不行）

### 0.1 现状数据

| 证据 | 数字 | 来源 |
|------|------|------|
| platformer 单次 acceptance pass rate | ≈ 12%（v11+v18 / 17） | audit §8 |
| mimo gen8 回归：4 轮修复循环后仍 escalate | round0 0/1 → round1 23/25 → round2 regressed 28 → round3 FAIL 45 | `games/generated-platformer-regression-mimo.validation.md` |
| mimo 单次生成超时 | 120s timeout，errorCount=1 | 同上 |
| mimo 裸写 HTML：build/smoke/首屏全过，但运行时每帧 419 次 pageerror，player 不动 | 跨段接口漂移（seg2 `Player.update(dt, input, level)` vs seg3 `player.update(dt)`） | `games/ab-test/REPORT.md` A1 |
| mimo + OpenGame 多文件模板：6 段里 4 段 thinking 失控（`finish_reason=length`，reasoning 23K-36K chars），只产出 5/13 文件 | 结构化 JSON + 项目级输出直接打爆 mimo | `games/ab-test/REPORT.md` A2 |

### 0.2 失败模式归因

把验证报告里的失败逐条归类，当前"**一次性生成整个游戏 → 外部验证器判卷 → 整体反馈重修**"的流程有四个结构性问题：

1. **状态生命周期一口气写断**。模型能写出语法正确的 Canvas 代码，但"输入处理 → 碰撞 → 状态变更 → 胜负判定"整条链一次写完，任何一环断了整个游戏不可玩，且验证器只能在最后才发现（gen8 报告里 stomp/bump/ability/gate 四类 runtime 证据全缺）。
2. **契约错误事后才暴露**。`snapshot()` 指标路径写错（如引用不存在的 `abilities.doubleJump`，gen8 step 7）要等整局生成完、进了 acceptance 才报，而这本可以在第一分钟掐掉。
3. **修复轮之间没有记忆**。repair loop 只把 failure 列表注回 prompt，模型不知道"上一轮我改了什么、为什么改坏了"，gen8 round2 出现 28 项 regressed 就是盲修的直接后果。
4. **模型约束与任务形态错配**。A/B 实测确认 mimo-v2.5-pro 两条硬约束：prompt > 1K tokens 时 `enable_thinking: false` 失效、强 JSON schema 多文件输出失败率远高于松散 JS。而当前生成提示词恰好是"大 prompt + 全量输出"形态，撞在枪口上。

### 0.3 Codex 范式给的启发（borrow what）

OpenAI 2026-06 公布的游戏生成工作流（developers.openai.com/codex/use-cases）核心不是新能力，是**把生成组织成可验证的增量过程**：

- **PLAN.md 先行**：玩家目标 / 核心循环 / 操作输入 / 胜负条件 / 视觉方向 / 里程碑顺序，先拆解再动手；
- **AGENTS.md 约定**：每做完一个功能就用 build/test 命令验一下；思路和决定记在 `.logs/` 里迭代时回查；
- **agent 自己在浏览器试玩**（Playwright），不对味就改，而不是只等外部判卷；
- **可重复资产**：生成一批素材就把 prompt 存档，方便后续同款。

Neo 的基础设施（goal-mode 三层闸、managed browser、`gameArtifactRuntimeSmoke`、repair guard）都已存在，缺的只是把它们编排成这条流水线。

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 生成方式从"单次全量"改为 **GAMEPLAN 先行 + 里程碑增量**（W1） | 直接对症 0.2-1：状态生命周期拆成可单独验证的小步；同时贴合 mimo 约束（每段输出小、松散 JS、prompt 短） |
| D2 | **契约即里程碑 M0**：先实现 `__GAME_META__` + `step()/reset()/snapshot()` 并跑通探针，再写玩法（W2） | 对症 0.2-2：路径错误在第一个里程碑就暴露，不再陪跑全程 |
| D3 | 把 runtime smoke 探针**开放为生成期工具**，agent 在循环内自玩自验（W3） | 对症"裁判只在终点"：gen8 那串 `enemiesDefeated did not increase` 本应是 agent 写完 stomp 后 30 秒内自己看到的 |
| D4 | repair loop 增加 **`.logs/` 结构化病历**，跨轮注入"上轮改了什么/结果如何"（W4） | 对症 0.2-3 盲修 regression；与 audit 硬规则 4（monotonicity 回滚）配合 |
| D5 | 整条流水线跑在 **goal-mode** 容器内，`--verify` 挂 acceptance script（W5） | 复用三层闸而不是再造循环控制；闸 3 的 token budget / 无进展检测天然兜底 |
| D6 | **里程碑级模型路由**：核心引擎（物理/碰撞/状态机）路由强代码模型，关卡数据与视觉填充留 mimo（W5） | A/B 报告结论 1 的落地：流程改进救不了模型能力下限，路由救 |
| D7 | 验收侧零改动：acceptance 契约、BoN、repair cap、escalation 全部维持 audit 方案 | 边界清晰；生成侧达标只会让验收侧数字变好，不依赖验收侧配合改 |

## 2. 方案架构

```
用户请求（/goal 做一个平台跳跃游戏 --verify "acceptance script"）
        │
        ▼
┌─ Phase A: 规划 ────────────────────────────────────────┐
│ 生成 GAMEPLAN.md（玩法循环/操作/胜负/机制清单/里程碑序）   │
│ 机制清单直接从 PlatformerChecker 的契约词汇生成            │
│ （enemies/blocks/abilities/gates/comboChallenge）        │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase B: 里程碑增量生成（每个 ≤ 单段 6-8K tokens）──────┐
│ M0 契约骨架: __GAME_META__ + step/reset/snapshot         │
│     + 空场景渲染 → 探针工具自验 → 过了才进 M1             │
│ M1 移动+跳跃物理 → 自验 player.x/player.y 探针            │
│ M2 敌人+踩踏     → 自验 enemiesDefeated 探针              │
│ M3 block/ability/gate → 自验对应探针                     │
│ M4 关卡数据+视觉打磨 → browser visual smoke              │
│ ★ 每个里程碑 prompt 显式 echo 上一里程碑的接口签名         │
│ ★ 每个里程碑完成后 append .logs/progress.md               │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase C: 验收（现状不变）─────────────────────────────┐
│ gameArtifactValidator full contract + BoN + repair cap   │
│ repair prompt 注入 .logs/ 病历（上轮 diff 摘要+探针变化）  │
└────────────────────────────────────────────────────────┘
        │
        ▼
goal-mode 闸1（acceptance script 退出码）→ 闸2/闸3 → 完成或 escalate
```

## 3. 五个改造点（Work Items）

### W1 — GAMEPLAN 先行 + 里程碑增量生成

**现状**：`generate-and-validate` 模式一次 prompt 产出整个 HTML（gen8 路径），120s 超时和接口漂移都源于此。

**改造**：
- 生成入口先产出 `GAMEPLAN.md`（结构对齐 Codex 教程：玩家目标、核心循环、操作输入、胜负条件、机制清单、里程碑顺序）。机制清单不让模型自由发挥——直接从 `src/main/agent/runtime/game/platformer/PlatformerChecker.ts` 的契约词汇表生成，保证"计划里写的"和"验收时查的"是同一组词。
- 里程碑序列固定为 M0→M4（见 §2 图），每个里程碑一次模型调用，输出限制在单段 6-8K tokens 内（A/B 报告 finding 1：mimo 必须流式 + 拆小调用）。
- **接口防漂移**：每个里程碑的 prompt 末尾显式 echo 上一里程碑产出的类/函数签名（A/B 报告建议 3 的落地），由代码层从上一段产物里抽取，不靠模型记。
- 输出形态用"松散 JS 段落拼装"（A1 路线），不用多文件 JSON schema（A2 已证伪）。

**涉及**：`src/main/agent/runtime/` 游戏生成入口、prompt 模板。

### W2 — 契约前置（M0 = 契约骨架）

**现状**：`step()/reset()/snapshot()` 契约和 `__GAME_META__` 在全量生成里"顺带"写，指标路径写错要到 acceptance 才发现。

**改造**：
- M0 只做三件事：空场景渲染、契约三函数、`__GAME_META__` 机制声明。完成后立即用探针工具跑"契约自检"（字段路径存在性 + step 可驱动 + reset 可复位），不过不进 M1。
- 契约自检失败的修复就发生在 M0 内部，成本是几百 tokens，而不是整局重来。

**涉及**：`gameArtifactRuntimeSmoke.ts` 的契约检查部分抽出可单独调用的子集。

### W3 — 探针工具化：agent 生成期自玩

**现状**：`runRuntimeSmoke` / `runBrowserVisualSmoke` 只在 acceptance 阶段由验证器调用，agent 生成期看不到。

**改造**：
- 新增生成期工具 `game_probe`（薄封装现有 runtime smoke 探针）：输入 = 产物路径 + 要验证的机制（如 `stomp_enemy`），输出 = 探针结果（before/after 状态对比，与 validation report 同格式）。
- 每个里程碑的提示词约定（Codex AGENTS.md 风格，进系统提示）："每完成一个机制，先调 `game_probe` 自验，FAIL 就地修，PASS 才报告里程碑完成"。
- 探针结果同时落 `.logs/`（W4 的输入）。

**涉及**：`src/main/tools/` 新增工具模块 + `gameArtifactRuntimeSmoke.ts` 导出探针子接口。复用现有 system Chrome CDP 链路，无新依赖。

### W4 — `.logs/` 跨轮病历

**现状**：repair loop 只注入 failure 列表（`artifactRepairProjection.ts`），模型不知道上轮动作，gen8 round2 regressed 28 项。

**改造**：
- 产物目录旁新增 `.logs/progress.md`：每个里程碑/每轮修复 append 一条结构化记录——本轮目标、改动摘要（diff 级）、探针 before/after、结论。
- repair prompt 注入最近 N 轮病历摘要（与 audit 硬规则 1 "minimum diff" 配合：病历让模型知道哪些部分已 work，不许碰）。
- 病历同时是 escalation 报告的素材：升级到人工时直接给完整时间线。

**涉及**：`artifactRepairGuard.ts` / `artifactRepairProjection.ts` 的上下文组装。

### W5 — goal-mode 编排 + 里程碑级模型路由

**现状**：游戏生成有自己的 acceptance loop（bonN/repairCap/escalation），与 goal-mode 是两套循环控制。

**改造**：
- 提供一条打包路径：`/goal <游戏描述>` 触发时，Phase A-C 整体作为 goal 执行体，`--verify` 挂 acceptance script（闸 1 确定性判卷），闸 3 的 token budget / 连续无进展检测天然替代"不要无限重试"的手写逻辑。审计 nudge（每 3 轮"假设未完成找证据"）对长流水线免费生效。
- **模型路由**：M0-M2（契约+物理+碰撞，强逻辑）路由到代码强模型（Kimi K2.6 / DeepSeek V4，走现有 `modelRouter.ts` 分层）；M3-M4（关卡数据、视觉、文案）留 mimo。这是 A/B 报告建议 1（"用 Mimo 跑 GDD/classify/短答任务，多文件代码生成换模型"）的工程化。
- mimo 的 `enable_thinking: false` 长 prompt 失效问题在路由层规避（强逻辑段根本不发给 mimo），不与模型供应商行为对赌。

**涉及**：`goalModeController.ts`（无改动，纯使用方）、`modelRouter.ts`（增加里程碑维度的路由标签）。

## 4. 实施阶段

| Phase | 内容 | 验证方式 | 预期 |
|-------|------|---------|------|
| P0 | W3 探针工具化 + W2 契约前置（不动生成结构，先让 agent 能自验） | 重跑 gen8 同 prompt，对比"契约类失败"是否在生成期被拦截 | 契约路径错误（gen8 step 7 类）归零 |
| P1 | W1 GAMEPLAN + 里程碑增量（mimo 单模型，先验流程价值） | `games/` 回归集重跑，记 round0 pass rate | round0 探针 PASS 数显著高于 23/48 基线 |
| P2 | W4 病历 + 接入 repair loop | 回归集重跑，看 regression 项 | round2 类 regressed（28 项）压到个位数 |
| P3 | W5 goal-mode 打包 + 模型路由 | 端到端 `/goal` 跑通三种终态（met/repair 继续/abort） | 单次 acceptance pass ≥ 30%（对齐 audit §8 Phase 0 目标），BoN=3 ≥ 80% |

每个 Phase 改 prompt 前拍 baseline snapshot、跑完整 acceptance（audit 硬规则 5/6），P1 起所有回归数据进 `games/` 验证报告同格式留档。

## 5. 不做什么（Non-Goals）

- **不改验收契约**：`__GAME_META__` schema、探针语义、PASS 标准维持现状，本方案只改"怎么把卷子答对"。
- **不做 OpenGame 多文件模板集成**：A/B 已证伪 mimo 路线；等 P3 后有了稳定多文件主模型再评估（对应 audit 公开问题 1 的节奏）。
- **不引入 LLM-as-judge**：客观机制严格走 deterministic probes（audit 公开问题 4 的既定立场）。
- **不在本期做 platformer 之外的流派**：流派扩展走 audit Phase 2-3 的 skill dispatch 架构，本方案的 W1-W5 设计为流派无关（GAMEPLAN 机制清单从 checker 词汇表生成，换流派换词表）。

## 6. 风险与开放问题

1. **里程碑增量会放大调用次数**（1 次 → 5-7 次）。但单次更小更稳：A1 三段全部 `finish=stop`、合计 139s vs 单次 120s 超时。token 总量预期持平或更低（无整局重写）。需要 P1 实测确认。
2. **接口 echo 的抽取实现**：从松散 JS 里抽类/函数签名用正则还是轻量 AST？建议先正则（产物形态受控），P1 验证不够再升级。
3. **强模型路由的成本**：M0-M2 用 Kimi/DeepSeek 比 mimo 包月贵。需要在 P3 拿 pass rate 提升数据后算单局成本账（pass rate 翻倍 = 重试减半，大概率净省）。
4. **`game_probe` 工具暴露给模型后被滥用刷轮次**：用 goal-mode 闸 3 的 token budget 兜底 + 工具调用计数进 `.logs/`。
5. **与 audit Phase 2（skill dispatch 抽取）的时序**：本方案 P0-P2 不依赖 dispatch 重构，可并行；P3 的流派无关化最好等 dispatch 落地后对齐。需要排期决策。

## 7. 成功指标（对齐 audit §8）

| 指标 | 现状 | 本方案 P3 后 |
|------|------|-------------|
| platformer 单次 acceptance pass rate | ≈ 12% | ≥ 30% |
| platformer BoN=3 pass rate | 未系统测过 | ≥ 80% |
| 契约类失败（snapshot 路径错/META 缺失）占比 | gen8 中 2/20+ 条且陪跑全程 | 生成期归零（M0 拦截） |
| repair regression 项 | gen8 round2 = 28 | ≤ 5 |
| 单局端到端时长 | gen8 = 494s（4 轮失败收场） | 首局 ≤ 600s 且以 PASS 收场为主 |
