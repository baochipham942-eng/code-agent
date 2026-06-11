# MiMoCode vs Neo 核心功能实现差异分析

> 日期：2026-06-11
> 对象：[XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)（小米开源，OpenCode fork，TS/Bun）vs Neo（本仓库）
> 方法：MiMo-Code shallow clone 至 /tmp/mimo-code，双侧代码级审查（4 个并行探索 agent）

## TL;DR

两个项目的强弱项几乎完全互补：**Neo 赢在执行基建**（上下文压缩深度、goal 验证严格性、真正的 workflow 引擎），**MiMoCode 赢在学习闭环**（best-of-N、dream、distill 三项 Neo 都没有，而 MiMoCode 是完整自动化实现）。

- MiMoCode 设计哲学：把状态外置到持久记忆文件，靠 checkpoint 重建上下文，靠独立 Judge 模型把关质量，靠定时自动任务实现自进化。
- Neo 设计哲学：在 session 内做确定性的工程化压缩和代码层验证，不信任模型自报。

## 六项核心能力对比总表

| 能力 | MiMoCode | Neo | 谁强 |
|------|----------|-----|------|
| 无限上下文 | ✅ checkpoint 重建式 | ✅ 6 层递进压缩 | 路线不同，Neo 工程更深 |
| 多决策并发选优 | ✅ Max Mode（完整） | ❌ 未实现 | **MiMoCode** |
| Goal 自治循环 | ✅ 单 Judge，不持久化 | ✅ 三层闸 + 跨 session | **Neo** |
| Dynamic workflow | ✅ Compose（prompt 驱动） | ✅ 双引擎（代码驱动） | **Neo** |
| Dream | ✅ 完整 + 7 天自动 | ❌ 未实现 | **MiMoCode** |
| Distill 自进化 skill | ✅ 完整 + 30 天自动 | ❌ 仅手动 skill_create | **MiMoCode** |

## 1. 无限上下文 — 「压缩派」vs「重建派」

**MiMoCode 是重建派**（`session/compaction.ts` 544 行、`session/checkpoint.ts` 1200+ 行、`session/overflow.ts`）：核心不是压缩而是**把状态外置**。

- 系统自动触发 checkpoint-writer 子 agent，把会话状态写成结构化 `checkpoint.md`（11 个 section：目标、任务进展、设计决策、笔记等）
- 上下文逼近上限（COMPACTION_BUFFER=20K 预留）时，用 LLM 摘要 + prune（裁掉最近 2 轮用户回合之外的旧工具结果，PRUNE_MINIMUM=20K 门槛）腾空间
- 中断后由 `computeBoundary()` 从最新 checkpoint + 项目 MEMORY.md + 任务 progress + 尾部 10-20K token 消息**重建**上下文
- 各部分按 token 配额注入（`readBudgeted()` / `readBudgetedSectionAware()`，push_caps 可配）
- "无限"的本质：会话可以无限长，因为可丢弃的都落了盘，随时能从文件重建

**Neo 是压缩派**（`src/main/context/compressionPipeline.ts`）：6 层递进压缩，按 usage ratio 确定性触发：

- L0 工具结果预算 → L1 observation masking（≥50%，保护活跃文件最后一次读避免重读死循环）→ L2 snip 占位符（≥50%）→ L3 文本密集化（≥60%）→ L4 AI 摘要（≥75%）→ L5/6 autocompact + 溢出恢复
- 超预算结果先落盘再截断（spillSessionId = GAP-009）

**差异**：Neo 的压缩管线粒度更细、更确定性（不依赖 LLM 的层占多数）；MiMoCode 的 checkpoint 重建和持久记忆打通，**天然支持跨 session 续作**——这是 Neo 压缩路线覆盖不到的场景。

## 2. 多决策并发选优 — MiMoCode 独有（Max Mode）

`session/max-mode.ts`（398 行），`experimental.maxMode` 开启，主循环每个 step 生效：

1. **并发候选**：`runMaxStep()` 并发跑 N 个候选（默认 5，可配 `candidates`），每个候选跑在 **propose-only 模式**——`toSchemaOnlyTools()` 把工具剥成只有 schema 没有 execute 闭包，候选只"提案"工具调用不真执行
2. **Judge 裁判**：所有候选的 reasoning/text/tool calls 渲染给独立 Judge 模型，系统提示"选最正确最安全的候选"，Judge 只回一个整数索引（解析失败 fail-open 选 0）
3. **赢家执行**：`handle.replay()` 真正执行赢家的 tool call
4. **成本隔离**：落选候选和 Judge 的成本计入 `overhead`，不污染上下文 token 估算
5. **降级**：全部候选失败回退单次正常 `handle.process()`

**Neo 现状**：未实现。`ParallelAgentCoordinator` 是多 agent 干不同任务的并行，不是同一任务多候选；goal-review 是事后评估不是生成时采样。

**结论：这是 Neo 最值得直接抄的设计**——propose-only + judge + replay 三段式解决了 best-of-N 最难的副作用问题（不能让 5 个候选都真的改文件）。

## 3. Goal — Neo 明显更严格

| 维度 | MiMoCode (`session/goal.ts`, 233 行) | Neo (`goalModeController.ts` + 双 gate) |
|------|------|------|
| 完成判定 | 单一 LLM Judge 读全量转录给 verdict `{ok, impossible?, reason}` | L1 硬闸（shell verify 退出码）→ L2 软闸（review 子 agent）→ L3 兜底（budget/max-turns/无进展强停） |
| 防模型自欺 | Judge 可返回 `impossible` 提前止损 | 每 3 轮注入"假设未达成、逐项找证据"审计 nudge |
| 循环上限 | MAX_GOAL_REACT=12 硬编码 | --budget token 上限 + --max-turns 可配 |
| 跨 session | ❌ 仅内存（InstanceState），session 结束即失 | ✅ GoalTracker 持久化 + GoalStatusBar UI |

MiMoCode 把完成权交给 Judge 模型（智能但可被骗）；Neo 把完成权放在代码层（确定性 verify 优先，LLM 只做软评审）。**Neo 唯一可借鉴：`impossible` verdict**——目标不可达时主动止损，比无进展计数语义更清晰。

## 4. Dynamic Workflow — 引擎 vs 提示词编排

**Neo 是真引擎**：
- 命令式 scriptRuntime（模型当场写 JS，worker 沙箱，agent/parallel/pipeline/phase/log 五原语 + forced tool_choice + token budget + 源码重放式 resume）
- 声明式 stage-DAG 双路径并存
- 控制流是确定性代码

**MiMoCode 的 Compose 是 prompt 驱动**：
- Tab 切到 Compose agent，系统提示（`session/prompt/compose.txt`，115 行）指示模型按需调用 skill 工具加载内置流程 skill
- 内置 compose skills：brainstorm / tdd / code-review / debug / verify / merge（编译进二进制的 `skill/compose/.bundle`）
- 靠模型自己串阶段；另有很薄的 `workflow/builtin.ts`（55 行，仅内置 deep-research）
- 编排确定性、并发控制、可恢复性远弱于 Neo，但实现成本低一个数量级，用户心智简单（"切个模式"）

## 5. Dream — MiMoCode 完整实现，Neo 空白

MiMoCode（`agent/prompt/dream.txt` 156 行 + `session/auto-dream.ts`）：

- 触发：手动 `/dream` 或**每 7 天自动**创建 "Auto Dream" 会话（config.dream.interval_days）
- 5 个 Phase：定位数据 → 读现有 MEMORY.md → 从 checkpoint/progress/notes 提取候选 → **用 bash + SQLite 只读查询去原始轨迹库（mimocode.db）验证**（防记忆幻觉）→ 编辑 MEMORY.md（Rules / Architecture decisions / Durable knowledge 三区，强制 <200 行 10KB）并清理过期条目
- 关键决策：**SQLite 轨迹库是权威来源，memory 文件只是缓存/索引**

Neo 没有等价机制：conversationJudge 只判断 session 值不值得存，runFinalizer 只做终态摘要。ADR-020"经验沉淀重做"方向上想做但管线没建。

## 6. Distill 自进化 — MiMoCode 完整、Neo 空白

MiMoCode（`agent/prompt/distill.txt` 200 行）：

- 触发：手动 `/distill` 或**每 30 天自动**
- 6 个 Phase：盘点现有 skill/agent/command → 扫描记忆文件找重复信号（"again"、"every time"、"like last time"）→ SQLite 统计验证（相同 tool+input 出现 ≥2 次或高成本工作流）→ 候选打分（频率 ≥2 + 稳定输入 + 明确停止条件 + 不与现有资产重复）→ 按形态产出 `.mimocode/skills/<name>/SKILL.md` / custom agent / command → 自动被 skill 服务扫描注册
- 原则："优先扩展现有资产而非新建"

Neo：有 `skill_create` 工具（显式打包）+ SkillUsageTracker（使用频率追踪、衰减回收），即**闭环后半段全是现成的，缺的恰恰是前半段的模式识别管线**。

## 六项之外的能力差异

**双方都有但实现不同：**
- **持久记忆**：MiMoCode 用 SQLite FTS5 + BM25 检索，文件按 `memory/{scope}/{scope_id}/{type}/{key}.md` 布局，能索引导入 Claude Code 的记忆（cc_index）；Neo 用 embedding（Supabase pgvector）+ 记忆收件箱/审计面板。FTS5 方案零外部依赖、零 embedding 成本，对本地优先产品更合理。
- **Subagent**：MiMoCode 内置 build/plan/title/summary/compaction/explore/general 7 种 + 系统自动 spawn 的 checkpoint-writer/dream/distill，强制结构化返回头（Status/Summary/Files touched/Findings）；Neo 三档权限继承 + per-agent 浏览器隔离 + DAG 依赖编排，更重。
- **工具系统**：MiMoCode ~22 个内置（精简，特色：bash-interactive pty、shell invocation 调用模式、memory 工具权限与 permission 系统分离防 deny 规则破坏 checkpoint）；Neo 108+ 模块 + GuardFabric 多源权限竞争。
- **Session**：MiMoCode 有 git-backed snapshot undo/redo + 会话 share；Neo 有 rewind/fork/checkpoint。打平。
- **Provider**：Neo 14+ provider + 健康监控四状态机 + 显式降级链；MiMoCode 以 MiMo 模型为中心（model_groups: ultra/standard/lite 按任务路由），其余走 OpenAI 兼容。

**MiMoCode 独有**：语音输入管线（TenVAD 实时断句 + mimo-v2.5-asr 转写 + LLM 解析语音指令为编辑/发送/切 agent 结构化动作）；enterprise 包 + team 隔离；OpenTelemetry tracing；8 语言 i18n TUI。

**Neo 独有**：Eval 体系（SWE-bench Docker harness + telemetry + replay）；桌面活动捕获（Appshot）；Computer Use（cua-driver）；Vision OCR / 照片人脸聚类；YAML hook 引擎 + cron；发版安全扫描。

## 对 Neo 的可落地启示（按 ROI 排序）

1. **Max Mode 三段式（propose-only → judge → replay）**：Neo 的 scriptRuntime 已有 forced tool_choice 和并发基建，schema-only 工具剥离是增量改动。
2. **Distill 管线**：Neo 缺的只是模式识别前半段，后半段（skill_create、热加载、usage 衰减）全是现成的。照 distill.txt 的 6-Phase prompt + SQLite 频率统计补一个 distill agent 即可闭环。
3. **Dream 的"轨迹库为权威、记忆为缓存"原则 + 7 天自动调度**：直接回应 ADR-020，MiMoCode 验证了纯 prompt 驱动（无需新基建）就能落地。
4. **Goal 的 `impossible` verdict**：小改动，补"目标不可达主动止损"语义。
5. **反向参考（Neo 已做对的）**：MiMoCode 的 goal 不持久化、compose 无确定性控制流、judge 单点信任——面试/作品集讲架构对比时的现成差异化论据。
