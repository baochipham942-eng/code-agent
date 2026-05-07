# Game Acceptance Architecture Audit & Refactor Plan

**Date**: 2026-05-07
**Trigger**: v8 platformer acceptance 修复 17 轮（v10–v26）烧了几天额度仍未收敛。怀疑硬编码过拟合。
**Scope**:
- `src/main/agent/runtime/gameArtifactValidator.ts` (2058 行)
- `src/main/agent/runtime/artifactRepairSpec.ts` (489 行)
- `src/main/agent/runtime/artifactRepairGuard.ts` (154 行)
- `src/main/prompts/artifactGeneration.ts` (90 行)
- `scripts/acceptance/platformer-gameplay-generation.ts`

**Verdict**: 当前 "Game Artifact Contract" 是**假泛化、真过拟合**。`game` 这个抽象层是名字泛化、行为不泛化。需要结构性重构，不是再加 prompt 补丁。

**Author**: 劳拉（接手艾克斯的 v8 修复任务，暂停执行链路，转向架构 audit）

---

## 1. Executive Summary

- v10–v26 共 17 个版本里 **v11、v18 已经 PASS 过**，证明 contract 可达。中间 60% 是绕圈或退化（同一类失败重复出现 7–10 次）。
- v25 离 PASS 只差 2 条 reachability 数值约束。艾克斯的 v26 修复**没有清掉这 2 条**，反而把 v25 已经 proven 的 stomp/ability/gate/combo 退化掉了——典型"一刀清歧义、顺手重写整篇 prompt"陷阱。
- 问题不在某一个 prompt 补丁，**根因在三层**：
  | 层级 | 问题 | 触发场景 |
  |------|------|---------|
  | L1 | schema 字段 `expect` 语义双重（exact equality vs numeric target）| 单次 reachability 失败 |
  | L2 | 把概率性 LLM 输出当 deterministic bug 修 | 修 7+ 次同一类问题 |
  | L3 | 整个 acceptance 链路硬编码 platformer | 假装支持 5 种游戏，实际只 1 种 |
- 工程债量化：**78 处 platformer-specific 硬编码 / 2791 行核心代码**（≈ 95% 渗透率）。
- 触发器识别 5 种游戏类型，validator 只处理 1 种。其他 artifact kinds（document / image / data_workbook / code_project）**0% 验证基础设施**。
- 行业参考收敛到三个共识：(a) 三层验证流水线 (b) skills 用 markdown 渐进披露 (c) self-repair 硬上限 2–3 轮。我们目前 **0/3 命中**。
- **行动**：停 v27，进入 Phase 0–1 短期收口（本周），Phase 2–3 结构重构（2–4 周），Phase 4 跨 kind 扩展（下月）。

---

## 2. Diagnosis

### 2.1 v10–v26 Failure Ledger

| 版本 | 状态 | 核心失败 | 与上一版关系 |
|------|------|---------|--------------|
| v10 | fail | Stomp + Bump + Combo 全失败 | 起点 |
| **v11** | **✅ PASS** | — | 抽中可用 |
| v12 | fail | reachability `metric: 'progress'` 不在 snapshot + Combo + Stomp | **回归**（v11 → v12 退化） |
| v13 | fail | reachability `progress` ×2 | 同 v12 子集 |
| v14 | fail | `progress` + Combo + Bump | 同类 |
| v15 | fail | `progress` + Combo + Stomp | 同类 |
| v16 | fail | `progress` + Gate + Combo + Stomp | 同类 |
| v17 | fail | Combo + reachability 数值 55/480 | 部分新（数值化首次出现） |
| **v18** | **✅ PASS** | — | 抽中可用 |
| v19 | fail | metadata + smoke 直改 + Stomp + Ability | **回归**（v18 → v19 退化） |
| v20 | fail | Combo + reachability 元数据缺失 | 同类 |
| v21 | fail | 网络错误 | 不算 |
| v22 | fail | Combo | 同类 |
| v23 | fail | `progress` + Combo + smoke 直改 | 同类 |
| v24 | fail | Stomp | 同类 |
| v25 | fail | reachability 数值 55/490 | 离 PASS 最近 |
| v26 | fail | `progress` 复发 + Stomp/Ability/Gate/Combo 全退化 | **退化**（v25 → v26 退步严重） |

**两个石破天惊的事实**：

1. **v11、v18 已经 PASS**——契约是可达的，不是"修不动的难题"。
2. **回归发生过两次**（v11→v12、v18→v19）——artistic 改 prompt 会让"曾经能过的部分"再次失效。

**重复失败统计**：
- "reachability `metric: 'progress'` 不在 snapshot()" 在 v12/v13/v14/v15/v16/v23/v26 出现 **7 次**——修了 7 次没修住。
- "comboChallenge 失败" 在 v10/v12/v14/v15/v16/v17/v20/v22/v23/v26 出现 **10 次**——修了 10 次没修住。

**结论**：17 次跑里至少 **9 次是绕圈**（重复同类失败 + 退化倒退），约 **60% 是无用功**。

### 2.2 Three Layers of Root Cause

#### L1: Schema 字段语义歧义（局部）

`expect` 字段在 validator 里当 "exact equality" 用（精确等于），但模型在 prompt 上下文里把它读成 "numeric expectation"（数值目标 / 阈值）。两套语义在 schema 设计时没显式分开。

- 影响范围：reachability 数值化失败（v17、v25）
- 修法：prompt 加一行 `For movement metrics use expect: "increase"/"decrease"/"change"; numeric expect = exact equality only.`
- 工作量：1 行 prompt 改动

#### L2: 概率性 LLM 输出当 deterministic bug 修（系统）

LLM 单次生成是抽奖。同一套 prompt 在 v11/v18 抽中可用版本，在 v12–v17、v19–v26 抽到不可用版本。艾克斯的修复方式是"看到一次失败 → 改一次 prompt → 加一道约束"，结果：
- prompt 越来越长
- 约束越来越多
- 某次重写时（v26）顺手把 v25 已经 work 的部分一起搞坏

正确做法不是 deterministic-bug 思维，是：
- **Best-of-N 采样**：生成 3 次取最优（execution-filter）
- **Self-repair 硬上限**：≤2 轮，超出换策略
- **Probe-pass monotonicity**：第 N 轮失败数 > 第 N-1 轮 → 立刻回滚

行业参考：
- Bolt.new 公开警告 "infinite fix loop" 是已知反模式（[Maximizing Token Efficiency](https://support.bolt.new/docs/maximizing-token-efficiency)）
- AlphaCode：百万样本 + execution-filter + 输入聚类 + top-10 cluster 抽样（[arXiv 2203.07814](https://arxiv.org/abs/2203.07814)）
- "How Many Tries Does It Take" (2025)：自修复增益在 2 轮后递减（[arXiv 2604.10508](https://arxiv.org/html/2604.10508)）

#### L3: 假装支持 game，实际只支持 platformer（架构）

整个 acceptance 链路 2791 行代码，**78 处硬编码 platformer 概念**。触发器识别 5 种游戏类型，validator 只处理 1 种。

详见 §3。

---

## 3. Quantified Architectural Debt

### 3.1 硬编码统计

| 文件 | 行数 | platformer 硬编码次数 | 渗透率 |
|------|------|----------------------|--------|
| `gameArtifactValidator.ts` | 2058 | 54 | ≈ 95% |
| `artifactRepairSpec.ts` | 489 | 13 | ≈ 60% |
| `artifactGeneration.ts` (prompt) | 90 | 11 | ≈ 50% |
| `artifactRepairGuard.ts` | 154 | 0 | 干净 |
| **总计** | **2791** | **78** | — |

硬编码概念示例：`stomp` / `bumpBlock` / `gameplayMechanics` / `enemies` / `blocks` / `abilities` / `gates` / `comboChallenge` / `doubleJump` / `wallJump` / `groundPound` / `enemiesDefeated` / `jumpBuffer` / `coyote`.

### 3.2 触发器假承诺

`src/main/prompts/artifactGeneration.ts:89`:

```ts
return needsArtifactTaskBrief(message) && /游戏|game|platformer|runner|tower[_\s-]?defense|puzzle|rpg|shooter|mario/i.test(message);
```

识别 **runner / tower defense / puzzle / RPG / shooter** 五类，但 validator 里只有一个 `if (subtype.includes('platformer'))` 分支。其他四类进入后会按 platformer 标准检查 → **必然失败 → 必然进入 repair 循环 → 必然又烧一轮 v10–v26 抽奖**。

### 3.3 Repair 系统也是 platformer-only

`artifactRepairSpec.ts:67-241` 有 34 个 failure code，**27 个 platformer-specific**（`missing_gameplay_mechanics`、`gameplay_mechanics_without_runtime_evidence`、`ability_gate_without_reachability` 等）。其余 7 个是通用结构错误（lost_interactive_contract 等）。塔防/解谜进来会全部命中 `generic_validation_failure`，失去具体修复指导。

### 3.4 其他 Artifact Kind 的现实

`ARTIFACT_TASK_BRIEF_PROMPT` 枚举了 7 类（document / image / presentation / data_workbook / interactive_app / code_project / other），实际验证基础设施：

| Kind | 验证 | 修复 | 位置 |
|------|------|------|------|
| game (platformer) | ✓ 全套 (2058 行) | ✓ 全套 (489 行) | `gameArtifactValidator.ts` |
| game (其他子类型) | ✗ 类型推断仅 | ✗ prompt only | 死代码：触发但跳过 |
| presentation/PPT | △ 仅 narrative flow (85 行) | ✗ 无 | `narrativeValidator.ts` |
| document | ✗ 无 | ✗ 无 | prompt only |
| image | ✗ 无 | ✗ 无 | prompt only |
| data_workbook | ✗ 无 | ✗ 无 | prompt only |
| interactive_app | △ HTML 结构 + 浏览器视觉 smoke | △ 部分 | 寄生于 game validator |
| code_project | ✗ 无 | ✗ 无 | prompt only |

**Gap**：声称支持 7 类，实际只有 platformer 一根独苗，独苗还过拟合。

### 3.5 已有积极信号（不全是负）

- `artifactRepairGuard.ts` 154 行，0 处 platformer 硬编码——保留得最干净，可以作为通用脚手架的种子
- `BrowserVisualSmoke` 检查（canvas 非空 / 视口 / 横向裁切）已经是**格式无关**的，对所有 HTML artifact 通用——可以直接复用
- `start/reset/snapshot/step/runSmokeTest` 这套**运行时契约**本身是 genre-agnostic 的（与 Phaser Scene 的 `init/preload/create/update`、Unity ECS 的 step 思路一致）——可以保留作为通用层
- PPT 已经分出独立 skill 路径（`frontend-slides` → `pptGenerate.ts` / `pptEdit.ts` / `narrativeValidator.ts`）——证明"按 artifact kind 分模块"的思路在仓库里已经有先例

---

## 4. Industry Reference

### 4.1 关键产品对比

| 产品 | 核心模式 | 关键启发 |
|------|---------|---------|
| **Replit Agent 3**（最接近本仓库形态）| Manager / Editor / **Verifier** 三角，Verifier 在 REPL 里跑 Playwright + DOM + ARIA。专门防 "Potemkin interfaces"（UI 渲染但事件没接） | 我们目前没有 Verifier 子 agent；browserVisualSmoke 只检查"画布非空"，是 Potemkin 级别 |
| **v0 (Vercel)** | 没有 per-domain validator，统一过 fine-tuned `vercel-autofixer-01` 流式后处理（86% 错误率清零） | 横向 vs 纵向选择题。我们当前是"假纵向" |
| **Bolt.new** | 单 artifact + WebContainer 终端反馈循环，自动捕获 stack trace 注入下一轮 prompt | 我们的 repair 循环没接终端/console；只能拿 validator 文本反馈 |
| **Lovable** | 收窄技术栈（React+TS+Tailwind+shadcn+Supabase）→ 失败模式收敛 → linter 够用 | 收窄是替代纵向 dispatch 的合法策略 |
| **Cursor / Aider** | TDD 闭环：Edit → Lint → Test → Fix。规则常驻、Skill 动态加载 | 二元结构：always-on rules + on-demand skills |
| **Claude Code** | Skills（markdown + 渐进披露三级：metadata / body / references）+ Hooks（25 生命周期事件，验证用 PostToolUse + Stop） | 这是 Anthropic 自家的标准答案 |
| **SWE-agent** | 用 blocking linter + "精心写的错误信息"把 SWE-bench 从 3.8% → 12.5% | **validator 的可读性比智能更重要** |
| **AlphaCode** | 百万采样 → execution filter → I/O 行为聚类 → top-10 cluster | 有 oracle 时 BoN + 聚类 > 学习 RM |

来源：详见调研附录（节末）。

### 4.2 三个收敛共识

#### 共识 1：三层验证（cost-gated）

| Tier | 检查 | 成本 | 例 |
|------|------|------|----|
| **L1 静态** | 语法 / 类型 / lint | ≈ 0 | SWE-agent blocking linter, v0 linter |
| **L2 运行时** | 启动 / 崩溃 / dep | $ | Bolt 终端 watcher, Aider test runner |
| **L3 行为** | "实际能否做这事" | $$$ | Replit Playwright probe, AlphaCode I/O 聚类 |

**我们当前**：L1 全无（生成的 HTML 没 lint/type check），L2 部分（runSmokeTest 算 L2 的 step），L3 半个（browserVisualSmoke 是 Potemkin 级别）。

#### 共识 2：Skills as markdown，不是 TS dispatch

**没有任何主流产品**用 `Map<Type, Validator>` 类型 dispatch。最接近的是：
- Replit Skills：markdown + `description` 匹配，proactive / reactive 两种激活
- Claude Code Skills：SKILL.md + 渐进披露 + name/description 触发
- Cursor：rules（always-on）+ skills（on-demand）

模式是 **soft dispatch via LLM-readable description**，不是 hard dispatch via TS discriminated union。

#### 共识 3：Self-repair 硬上限

- 增益主要在 1–2 轮，3+ 轮递减
- 第 3 轮**换策略**而非重发同样 prompt：换模型 / 问用户 / 退到已知模板
- 监控 probe-pass monotonicity，退化即止损（Bolt 反模式）

### 4.3 游戏框架的抽象层共识

调研 Phaser / PixiJS / Three.js / Godot / Unity / PuzzleScript / GameMaker：

- **每个成熟引擎都用一层薄薄的通用契约**：Phaser `Scene`、Godot `node + signal`、Unity `ECS + System`。**没有任何引擎在内核里写"platformer mode"**。
- 我们的 `start/reset/snapshot/step(input)/runSmokeTest` 与 Unity `Virtual Players` 消费的契约**结构同构**——这一层保留。
- 但纯运行时契约不够。需要在它上面架一层 **mechanics-verb 断言层**——具体到"你声称能跳，那就用 step 触发跳，看 snapshot 里 player.y 真的变化"。
- "完全 per-genre" 是反模式（你已经在坑里）。"verbs only 没运行时契约"也不行（失去确定性）。**两层组合**才是答案。

### 4.4 Mechanics 跨流派词汇表

来自 MDA 框架（Mechanics-Dynamics-Aesthetics）+ Anthropy 的 verb-object 设计 + Koster 的"四类乐趣"：

| 类 | 动词 | Platformer | Runner | Tower Defense | Puzzle | RPG | Shooter |
|----|------|-----------|--------|---------------|--------|-----|---------|
| **Movement** | `moveTo` | walk/jump | auto-run | camera pan | grid slide | walk | strafe |
| | `traverse` | jump gap | dodge lane | — | — | climb | cover |
| **Acquisition** | `collect` | coins | pickups | gold drops | keys | loot | ammo |
| | `unlock` | door key | distance gate | tech tree | switch | quest flag | level access |
| **Conflict** | `defeat` | stomp | obstacle | tower kills creep | — | combat | shoot |
| | `defend` | — | — | base/lane | — | tank role | escort |
| | `evade` | spike pit | obstacle | leak | — | stealth | dodge |
| **Construction** | `build` | — | — | place tower | — | crafting | base build |
| | `upgrade` | power-up | speed-up | tower tier | — | level up | weapon mod |
| **Cognition** | `solve` | — | — | wave plan | core | quest logic | tactical |
| | `navigate` | level exit | — | path layout | — | dungeon | map |
| **Progression** | `complete` | reach flag | distance | survive N waves | clear board | quest done | clear stage |
| | `fail` | death pit | crash | base destroyed | unsolvable | party wipe | health 0 |

每个 verb 三件套：**selector**（在 snapshot 里怎么找到主语）+ **success predicate**（成功条件）+ **liveness predicate**（从 start 状态 ≤N 步可达）。

平台游戏的 `stomp` 是 `defeat` 的一个特化（"land on enemy from above"），不是 validator 内核里的硬编码概念。

---

## 5. Proposed Architecture

### 5.1 三层模型

```
Layer A: ArtifactKind dispatcher       (TS hard dispatch, 5–10 stable kinds)
   ├── game            → GameVerifier
   ├── slide-deck      → DeckVerifier
   ├── document        → DocVerifier
   ├── data-workbook   → WorkbookVerifier
   ├── dashboard       → DashboardVerifier
   └── code-project    → CodeProjectVerifier

Layer B: Skills (markdown + progressive disclosure)
   ├── skills/platformer-game/SKILL.md      (genre knowledge for prompt)
   ├── skills/tower-defense/SKILL.md
   ├── skills/runner/SKILL.md
   ├── skills/executive-deck/SKILL.md
   ├── skills/academic-paper/SKILL.md
   └── ...
   每个 skill 含: SKILL.md (frontmatter + body) + mechanics.md + probes.md

Layer C: Probes (assertion packs)
   ├── kind-probes/game.json         (verb-based, 跨 genre 通用)
   ├── kind-probes/deck.json         (slide count, narrative arc)
   ├── kind-probes/doc.json          (TOC, sections)
   └── skill-probes 由 skill 贡献追加
```

**职责分工**：
- **Layer A** 决定哪个 Verifier subagent 跑——硬 dispatch，类型稳定（5–10 个 artifact kind）
- **Layer B** 决定 generation 时塞什么 domain knowledge 进 prompt——LLM-readable，soft dispatch by description match，子流派任意扩展
- **Layer C** 是验收的 ground truth——declarative probes，validator 读取并执行

这是 Replit "Manager / Editor / Verifier 三角" 的泛化：ArtifactKind = 哪个 Verifier 跑；Skill = Editor 知道什么；Probes = Verifier 检查什么。

### 5.2 关键决策：Skill vs Subtype Dispatch

**用什么决定？**

| 维度 | Hard Dispatch (TS) | Soft Dispatch (Markdown Skill) |
|------|-------------------|-------------------------------|
| 数量稳定性 | 稳定，少量（5–10） | 可能爆炸（数十） |
| 类型契约 | 强（编译期） | 弱（runtime 文本匹配） |
| 用户/产品扩展 | 需开发改代码 | 写 markdown 即可 |
| 错误隔离 | 强 | 跨 skill 容易污染 |
| 适合的事 | artifact kind 这种粗粒度且稳定的 | 子流派、技术栈、风格、库选择 |

**结论**：
- **artifact kind 用 TS dispatch**（document/game/deck/doc/dashboard 是稳定的产品语义）
- **子流派用 skill markdown**（platformer/runner/td/puzzle/RPG/shooter 是会扩张的）
- **不要把两者混淆**——这是 Cursor / Claude Code / Replit 的共同选择

### 5.3 验收循环重设计

```
┌─────────────────────────────────────────────────────────┐
│ 1. ArtifactKind 推断 → 选择 Verifier                     │
├─────────────────────────────────────────────────────────┤
│ 2. Skill match by description → 注入 generation prompt   │
├─────────────────────────────────────────────────────────┤
│ 3. Best-of-N 生成（默认 N=3，可配）                      │
├─────────────────────────────────────────────────────────┤
│ 4. Verifier 三层验证（cost-gated）                       │
│    L1 静态: HTML 结构 / metadata schema / lint           │
│    L2 运行时: runSmokeTest / 浏览器启动                  │
│    L3 行为: verb probes（player can jump 等）            │
├─────────────────────────────────────────────────────────┤
│ 5. 排序选最优（execution-filter best-of-N）              │
├─────────────────────────────────────────────────────────┤
│ 6. 失败 → repair 循环（最多 2 轮）                        │
│    每轮检查 probe-pass-count monotonicity                │
│    退化 → 立即回滚到上一轮                                │
│    2 轮未过 → 换策略（升模型/问用户/兜底模板）            │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Migration Plan

### Phase 0：Stop the Bleeding（今明两天）

**目标**：把 v8 platformer 验收先收口，回到 v25 状态 + 1 行补丁。不再开 v27 v28 v29 这种盲改。

| # | 动作 | 文件 | 工时 |
|---|------|------|------|
| 0.1 | 回滚 prompt 到 v25 状态（git stash 或 revert artifactGeneration.ts 的 16 文件改动） | 16 个 modified files | 30min |
| 0.2 | 在 GAME_ARTIFACT_CONTRACT_PROMPT 的 reachability bullet 后加一行：`For movement metrics like player.x/y, use expect: "increase"/"decrease"/"change". Numeric expect = exact final equality only.` | `artifactGeneration.ts:55` | 5min |
| 0.3 | 把 acceptance script 改成生成 3 次取最优（execution filter best-of-3），先以"runtimePassed && browserPassed"打分 | `scripts/acceptance/platformer-gameplay-generation.ts` | 1h |
| 0.4 | 跑 v27/v28/v29 三次验证，至少 1 次过即止损 | — | 30min |

**Phase 0 完成判定**：3 次内有 1 次 PASS（基于 v11/v18 历史 pass rate ≥ 12%，BoN=3 大概率撞上）。

### Phase 1：Honest Narrowing（本周内）

**目标**：让触发器跟实际能力对齐，停止"假承诺"。

| # | 动作 | 文件 | 工时 |
|---|------|------|------|
| 1.1 | 把 `needsGameArtifactContract` 的正则收窄到只 `/platformer\|超级玛丽\|mario/`，移除 `runner\|tower-defense\|puzzle\|rpg\|shooter` | `artifactGeneration.ts:89` | 15min |
| 1.2 | 其他游戏类型走通用 `ARTIFACT_TASK_BRIEF_PROMPT` 路径，不进 game contract（宁可不验证，也别按 platformer 验非 platformer）| 无新文件 | 0min |
| 1.3 | 给被排除的游戏类型加 user-facing 注释："Currently auto-validated genre: platformer. Other genres: best-effort generation, no acceptance loop." | UI 提示位 / docs | 1h |
| 1.4 | repair guard 增加 `subtype !== 'platformer'` 的 short-circuit，避免拿 platformer 修法去修非 platformer | `artifactRepairGuard.ts` | 30min |

**Phase 1 完成判定**：跑一遍 acceptance suite，确认 platformer 行为不变 + 非 platformer 不再误触发 platformer 验证。

### Phase 2：Extract Dispatch Architecture（下周–下下周）

**目标**：抽出 `GameVerifier` strategy 接口。**不改行为，只改结构**。

| # | 动作 | 文件 | 工时 |
|---|------|------|------|
| 2.1 | 定义接口 `GameVerifier` (start/reset/snapshot/step 已经有) + `GameSubtypeChecker` (validateMechanics / validateRuntimeEvidence / repairGuidance) | 新文件 `src/main/agent/runtime/game/types.ts` | 2h |
| 2.2 | 把 `validatePlatformerGameplayMechanics`、`validatePlatformerGameplayRuntimeEvidence`、`validatePlatformerStepInputShapes`、`isPlatformerArtifact` 搬到 `src/main/agent/runtime/game/platformer/PlatformerChecker.ts`（行为不变） | 新文件 + 删除原文件对应段 | 4h |
| 2.3 | 引入 registry：`game/registry.ts` 注册 `{ platformer: new PlatformerChecker() }` | 新文件 | 1h |
| 2.4 | `gameArtifactValidator.ts` 主入口改用 `registry.get(subtype)?.validateMechanics(...)`，找不到就跳过（warn 一下）| 主入口改 ~50 行 | 2h |
| 2.5 | 同理拆 `artifactRepairSpec.ts` 的 platformer-specific failure code 到 `game/platformer/repairCodes.ts` | 新文件 + 拆 489 行 | 3h |
| 2.6 | 跑全套 acceptance（platformer 应该完全等价 + 0 行为变化）+ 单元测试 | — | 1h |

**完成判定**：`PlatformerChecker.ts` 文件大小 ≈ 旧 platformer 段大小，主入口零 platformer 关键词，acceptance pass rate 不退化。

### Phase 3：Verb-Based Abstraction（第 3–4 周）

**目标**：把 platformer 断言改写成 verb-based，用第二个 genre 验证可扩展性。

| # | 动作 | 工时 |
|---|------|------|
| 3.1 | 实现 verb taxonomy（§4.4 那张表）：每个 verb = `{ selector, success, liveness }`。先写 6 类 12+ 动词的 TS 定义 | 1d |
| 3.2 | 把 `PlatformerChecker.validateMechanics` 改写成"声明 verbs + 通用 verb runner 驱动"——stomp 变成 `defeat(enemy, byLandingFromAbove)` 的特化 | 2d |
| 3.3 | 实现 `RunnerChecker` 或 `TowerDefenseChecker`（挑一个），全部用 verb library 写，**不允许触碰 PlatformerChecker** | 2d |
| 3.4 | 写一个新流派的 acceptance test，证明 ≤200 LOC + 1 个 SKILL.md 即可加入 | 1d |
| 3.5 | 更新 trigger regex（Phase 1 收窄的）放回去，让新流派也被识别 | 30min |

**完成判定**：第二个流派 acceptance pass rate ≥ 60%（不需要 100%，证明架构能承载即可）。每加一个流派的工程量 ≤ 200 LOC + markdown。

### Phase 4：Other Artifact Kinds（第 5 周以后）

**目标**：把 dispatch 架构扩展到非 game artifact。

| # | 动作 |
|---|------|
| 4.1 | 提取 `ArtifactKindVerifier` 顶层接口（GameVerifier 是其特化） |
| 4.2 | `DeckVerifier`：复用现有 `narrativeValidator.ts`，加 L1（schema）+ L2（render）+ L3 probes（slide count, has_title, has_conclusion） |
| 4.3 | `DashboardVerifier`：参考 Replit anti-Potemkin 模式，加 click-to-state-change probe |
| 4.4 | `DocVerifier`：markdown lint + 编译 PDF/DOCX + word count probe |
| 4.5 | `WorkbookVerifier`：xlsx 读取 + cell schema + formula 引用检查 |

**完成判定**：5 个 artifact kind 都有非空 verifier；新增 kind 的工程量 ≤ 1 周。

---

## 7. Hard Rules / Anti-Patterns（写进 `CLAUDE.md` 或 codex-fix 护栏）

针对这次踩坑沉淀的禁止项：

1. **禁止"修一个语义点重写整个 prompt"**。改 prompt 必须 minimum diff——能加一行解决就不要重排版面。v25 → v26 把已经 work 的部分搞坏的根因。
2. **禁止把概率性 LLM 失败当 deterministic bug 修**。同一 prompt 失败 ≥3 次 = 进入 BoN / retry-with-feedback 路径，不是再加 prompt 约束。
3. **Self-repair 硬上限 2 轮**。第 3 轮换策略（升模型 / 问用户 / 兜底模板）。
4. **Probe-pass monotonicity gate**：第 N 轮 PASS 数 < 第 N-1 轮 → 立即回滚到 N-1 状态，不允许"再试一刀"。
5. **改 prompt 之前拍 baseline snapshot**：上一版本验收通过哪些 mechanics，新 prompt 让任何一个退化就 revert。
6. **每改一版 prompt 跑一次完整 acceptance**。不能只跑相关 unit test 就以为没事——v25 → v26 的退化只在端到端跑里才看得出来。
7. **acceptance script 默认 BoN=3**，单次失败不算 fail，3 次都失败才算。
8. **触发器收窄优先于扩张**——支持不了的子类型不要在 regex 里假装支持。

---

## 8. Success Metrics

| 指标 | 现状 | Phase 0 后 | Phase 3 后 |
|------|------|-----------|-----------|
| platformer 单次 acceptance pass rate | ≈ 12% (v11+v18 / 17) | ≥ 30% (1 行补丁 + BoN) | ≥ 60% |
| platformer BoN=3 acceptance pass rate | 未知（没跑过） | ≥ 80% | ≥ 95% |
| 加新游戏流派的工程量 | ≈ 1500+ LOC + 一轮 v10–v26 抽奖 | 同 | ≤ 200 LOC + 1 个 SKILL.md |
| 主入口 platformer 关键词数 | 54（gameArtifactValidator.ts） | 同 | 0 |
| 非 platformer 游戏触发 acceptance 的失败率 | 100%（必失败）| 0%（不再触发）| 取决于具体流派 |

---

## 9. 公开问题（需要爸决策）

1. **Phase 4 优先级**：等 Phase 3 证明架构可行后再做？还是 Phase 2 一完成就并行启动 PPT verifier（已有 narrativeValidator 种子）？
2. **BoN N=?**：默认 3 还是 5？成本 vs 通过率折中。建议先 3，监控 pass rate 调整。
3. **是否引入 Replit 风格的 Verifier subagent**？单独 sub-agent 跑 Playwright 检查 Potemkin 问题——这是 Phase 5 可选项，本次 audit 不强行排期。
4. **是否引入 LLM-as-judge**？仅用于主观维度（"游戏好不好玩"、"deck 叙事流畅否"）。客观维度严格走 deterministic probes。本次默认不引入。
5. **PPT 现有 `frontend-slides` skill + `narrativeValidator.ts`**：是否在 Phase 2 一并迁移到新 dispatch 架构？还是保持现状直到 Phase 4？建议 Phase 4 一并做，避免 Phase 2 范围蔓延。

---

## 10. 调研附录（来源）

### 行业产品
- [Vercel — v0 composite model family](https://vercel.com/blog/v0-composite-model-family)
- [stackblitz/bolt.new system prompt](https://github.com/stackblitz/bolt.new/blob/main/app/lib/.server/llm/prompts.ts)
- [Bolt — Maximizing Token Efficiency](https://support.bolt.new/docs/maximizing-token-efficiency)
- [Lovable — How to Develop an App](https://lovable.dev/blog/how-to-develop-an-app)
- [LangChain — Replit Agent breakout case study](https://www.langchain.com/breakoutagents/replit)
- [Replit — REPL-based verification](https://blog.replit.com/automated-self-testing)
- [Replit — Agent Skills](https://docs.replit.com/tutorials/agent-skills)
- [Cursor — Best practices for coding with agents](https://cursor.com/blog/agent-best-practices)
- [Anthropic — Equipping agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

### 学术 / 工程
- SWE-agent (NeurIPS 2024) — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
- AlphaCode — [arXiv 2203.07814](https://arxiv.org/abs/2203.07814)
- Self-Refine — [arXiv 2303.17651](https://arxiv.org/abs/2303.17651)
- Iterative compiler feedback — [arXiv 2403.16792](https://arxiv.org/abs/2403.16792)
- Self-repair scaling — [arXiv 2604.10508](https://arxiv.org/html/2604.10508)

### 游戏框架
- [Phaser Scene docs](https://docs.phaser.io/api-documentation/class/scene)
- [Godot key concepts](https://docs.godotengine.org/en/stable/getting_started/introduction/key_concepts_overview.html)
- [Chickensoft — Enjoyable Game Architecture](https://chickensoft.games/blog/game-architecture)
- [Unity — Automated tests](https://unity.com/how-to/automated-tests-unity-test-framework)
- [Unity — Virtual Players](https://unity.com/blog/games/automate-your-playtesting-create-virtual-players-for-game-simulation)
- MDA framework — [Hunicke et al.](https://users.cs.northwestern.edu/~hunicke/MDA.pdf)
- Raph Koster atomic theory — [raphkoster.com](https://www.raphkoster.com/2012/01/24/an-atomic-theory-of-fun-game-design/)

---

## 11. 这次踩坑的 meta lesson（建议写进 feedback memory）

**LLM 内容生成的验收链路里，单点失败不等于 prompt 没说清**。

第一反应改 prompt 是错的——要先看 pass rate 分布。`v11 PASS / v12 fail / v13 fail / ... / v18 PASS / v19 fail` 这种交替模式说明：契约写对了，模型抽奖输了。改 prompt 只能微调分布，不能消除分布。

正确的诊断顺序：
1. **先看 pass rate**：连续 3 次失败 vs 散点失败，处理方式完全不同
2. **散点失败** → BoN 采样 / retry / 不改 prompt
3. **连续失败** → 这才是 deterministic bug，改 prompt 才有意义
4. **退化** → 立即 revert，不要 patch on patch

艾克斯这几天违反了上面所有 4 条。劳拉这次也跟着错——前两轮回答里我把这事当成"修一个语义歧义"，没意识到要先看 pass rate 分布。这个 meta lesson 比 audit 本身重要。
