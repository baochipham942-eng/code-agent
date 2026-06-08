# ADR-020: 经验沉淀重做 —— 废弃 telemetry n-gram，统一走 LLM 反思路

## 状态
**accepted** | 2026-06-08

## 背景

经验沉淀（skill 自动提议）原有两条并联链路：

1. **telemetry n-gram 蒸馏**（`learningPipeline.extractSuccessPatterns`）：把连续成功的工具调用切成 2~4 长 n-gram，同一序列出现 ≥3 次即提议存为 skill，命名直接拼工具名。
2. **LLM 语义复盘**（`conversationReview`）：让 quick model 读对话语义，判断有无值得沉淀的 class-level 技能。

一次 dogfood 暴露 n-gram 路的根本缺陷：连跑 3 次 `bash` 就被提议成 `bash-bash-bash-bash` 草稿。根因——它把"工具调用频次"当唯一判据，跳过了语义判定，命名也来自工具名而非任务意图。

调研标杆 **Hermes Agent**（Nous Research）与 Voyager、Anthropic Agent Skills，结论一致：**重复频次不是信号**，"可泛化 + 有意图 + 经验证 + 可压缩成抽象"才是。Hermes 虽也有"5+ 工具调用"触发，但那只是"任务够复杂"的入口闸，真正决定"值不值得沉淀 / 叫什么名"的是后面那道 **LLM 反思**——这正是我们 n-gram 路缺失的。

## 决策

**废弃并物理移除 telemetry n-gram 自动提议路，skill 沉淀统一收口到 `conversationReview` 的 LLM 反思路，并升级到 Hermes/Anthropic 规格：**

- **入口闸**：任务完成 + 非平凡（≥2 种语义不同工具 / 多步有数据流依赖）。
- **反思门**（替代频次判据）：LLM 抽不出"可陈述的任务意图"→ 沉默不提议。
- **命名**：动名词 + 领域宾语（`deploying-tauri-macos`）；禁用泛词（helper/utils/tools/data/files/workflow）与工具名拼接（bash-bash-bash）。落到 `isLowValueSkillName` 在解析与入队两处拦截。
- **产物**：SKILL.md 结构化 —— 何时使用 / 步骤 / 坑 / 验证（复用 ADR-002 的 SKILL.md 解析与渐进加载）。
- **去重**：沿用 skillDraftQueue 的 rejected/accepted/pending 三账本（按 patternKey）。

failure journal 链路（重复失败模式 → Light Memory）不受影响，保留。

## 选项考虑

### 选项 1: 给 n-gram 路加语义过滤（保留）
- 优点：保留一个召回来源。
- 缺点：n-gram 的信号本质就是"点了哪几个工具"，加再多过滤也命不出有意义的名字；与 LLM 路职责重叠。Hermes/Voyager 均不采用纯频次。

### 选项 2: 废弃 n-gram，统一 LLM 反思路（采纳）
- 优点：信号正确（语义意图而非频次）；与标杆一致；命名/产物结构化；代码更简单。
- 缺点：少一个召回来源——由升级后的 LLM 路 + 跨会话复现加分弥补。

### 选项 3: 整个自动提议先关掉，纯手动建 skill
- 优点：零误报。
- 缺点：放弃自沉淀这一核心能力；与产品方向（自进化闭环）相悖。

## 后果

### 积极影响
- 不再产 `bash-bash-bash-bash` 这类垃圾草稿。
- 草稿命名从任务意图出发，可读、可检索。
- 删除约 80 行无语义代码 + 对应测试，降低维护面。

### 消极影响
- skill 召回依赖 quick model 的复盘质量；模型不可用时本轮不沉淀（静默降级，可接受）。

### 风险
- LLM 复盘 prompt 是 LLM-facing 改动，需配 eval 观察实际沉淀质量与误报率。

## 相关文档
- 设计与钩子点：[experience-distillation-and-uninstall-fixes.md](../designs/experience-distillation-and-uninstall-fixes.md)
- [ADR-002 Agent Skills 标准](002-agent-skills-standard.md)
- 标杆：[Hermes Agent](https://yuv.ai/blog/hermes-agent) · [Voyager (arXiv 2305.16291)](https://arxiv.org/abs/2305.16291) · [Anthropic Agent Skills 最佳实践](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
