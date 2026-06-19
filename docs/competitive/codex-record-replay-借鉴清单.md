# Codex Record & Replay 借鉴清单

> 来源：公众号《传统的 RPA 已死！Codex 推出王炸级功能 Record & Replay》（字节笔记本，2026-06-18）
> 调研方式：原文去魅 + 3 路并行子 agent 摸 Neo 现状（命令/技能系统、会话轨迹持久化、工程约定）+ 主控亲读 `distillService.ts` / `distillPrompt.ts` 复核
> 生成日期：2026-06-19
> 结论档位：🟡 小步试水 / 暂缓实现（已与用户确认：先落文档，不动代码）

---

## 1. 看穿这是个什么东西（去魅）

**本质**：OpenAI Codex App 的一个 Computer-Use 插件「Record a skill」。用户在 Codex 桌面端 Plugins 里点录制，然后**正常手动做一遍** GUI 任务（发视频、发公众号、电商上架），Codex 在旁边看，结束后把这套操作**合成成一份结构化 Skill**——不是录鼠标轨迹的机械回放，而是理解"数据从哪来 / 每步核对什么 / 什么状态算成功"，文件可读可改。下次给新素材 + 指定该 Skill，它用 Computer Use 执行。

**核心创新只有一个**：把"怎么把要自动化的事描述给 AI"这道摩擦，从「先写 SOP/提示词」换成「先做一遍，AI 帮你总结」。解决的是"越日常的工作越难被描述"——肌肉记忆（绿点才算连上、下拉选第二个）写不进 SOP，但能被演示捕捉。

**别被标题党唬住（shipped / planned / noop 边界）**：
- ✅ shipped：2026-06-18 发布。
- ⚠️ 重限制：**仅 macOS**；必须先开 Codex App 的 Computer Use；底层仍是**传统图片理解**的视觉方式（作者原话"未来应该会有强视觉模型才真正类人"）；**录出来的 Skill 不稳定、经常要人工修补**。
- "传统 RPA 已死"是营销修辞。它相对传统 RPA（Zapier/Make）的真实优势是**录意图而非录操作路径**——按钮挪了、页面变了，只要目标没变还有机会继续完成；传统 RPA 录的是脆弱的点击坐标。

## 2. 适用场景

**步骤固定、但很难写清楚的日常 GUI 重复劳动**。共性：你闭眼会做，但让你写成 SOP 就卡壳。原文列举：YouTube/公众号发布、淘宝拼多多抖音多平台上架、运营日报（广告后台 + GA4 + CRM → 表格）。价值密度在**逐字重复的 GUI 流程**最高。

## 3. 对照 Neo（as-built，带文件锚点）

### 🟢 我方已有、不用学：蒸馏系统本身

Neo 已有完整的**挖掘驱动**蒸馏系统：

| 能力 | 锚点 |
|------|------|
| 六阶段蒸馏编排（盘点→扫信号→频率验证→打分→产出→注册） | `src/main/services/skills/distillService.ts:412 runDistill()` |
| 频率硬门（≥2 次 distinct FTS 证据，代码化在 service 层） | `distillService.ts:474`（`DISTILL.MIN_OCCURRENCES`）|
| LLM 只在 Phase 5 出提案、不持有文件写入工具 | `src/main/agent/distillPrompt.ts:3 DISTILL_AGENT_PROMPT` |
| 落盘 emitter（command 优先于 skill） | `DistillEmitters.emitCommand/emitSkill` |
| 草稿队列（auto 模式产出物一律不激活，等人确认） | `distillService.ts:531`；`~/.code-agent/skill-drafts/` |
| `/distill` 触发 + 报告转述 | `distillPrompt.ts:33 DISTILL_SKILL_PROMPT` |
| **读整条会话轨迹（含工具调用+入参+结果+决策）** | `src/main/services/core/databaseService.ts:462 getSessionLedger()` |

### 🟡 范式缺口：演示驱动入口（这才是 Record & Replay 的可借鉴内核）

Neo 的 `/distill` 是**挖掘驱动**——扫最近 7 天会话，正则抓"每次/每周/又要"重复信号，**至少 2 次**才固化。它回答"你反复在做什么"。

Record & Replay 是**演示驱动**——用户做**一遍**当场说"固化它"，**1 次就够**，意图=显式调用本身。它回答"我刚做完这件事，下次你替我做"。

→ **两者互补，不重复**。`/distill` 的频率≥2 硬门恰恰**挡死**单次演示场景。所以借鉴目标不是"造蒸馏系统"（已有），而是**给现有基建加一个"单会话演示→技能"的旁路入口**。

### ❌ 不学：Computer Use / GUI 自动化品类

Record & Replay 解决的是**桌面 RPA 替代**（驱动任意 GUI 应用做非编程杂活）。Neo 是编程 Agent，操作的是代码库/文件/bash/MCP。把通用 GUI 录制塞进 Neo 是错品类。
（注：Neo 另有 `docs/decisions/021-computer-use-cua-driver.md` 与 `designs/ws5b-computeruse-mcp-security.md` 的 CUA 探索，但那是独立议题，不是本借鉴点的落点。）

## 4. 借鉴判断

| 维度 | 裁决 |
|------|------|
| GUI / Computer-Use 内核 | ❌ 错品类，不抄 |
| **"演示→结构化技能"范式** | 🟡 有真内核，但落在已有 distill 基建的增量上，小步试水级 |
| 直接功能借鉴价值 | 低（核心是 CUA） |
| 范式提醒价值 | 中（补 distill 的"单次演示"盲区）|

**泼冷水（仍成立）**：编程任务的演示复用度，天然低于"发公众号/电商上架"这类逐字重复的 GUI 流程——这也是 Claude Code 至今没做"录制会话成 skill"按钮的可能原因。故定档 🟡 **暂缓**，不是必做。

## 5. 若要做：实现方案（已设计，未实现）

**一句话架构**：新增 `/distill-session` 命令 → 读当前/指定会话的 `getSessionLedger()` 整条轨迹 → 喂给新的"结构化意图提取"prompt → 走现有 emitter 落成**草稿** skill → 用户改完激活。**不碰**现有挖掘路径的频率门。

### 复用 vs 新增（省力关键：复用约 80%）

| 能力 | 状态 | 锚点 |
|------|------|------|
| 读整条会话轨迹（含 tool calls + params + 结果 + 决策） | ✅ 复用 | `databaseService.ts:462 getSessionLedger()` |
| 落盘成 skill/command | ✅ 复用 | `DistillEmitters.emitSkill/emitCommand` |
| 草稿队列（人改后激活） | ✅ 复用 | `skill-drafts/` + `rejectedNames` 账本 |
| 提案字段校验（名字/长度/重名门） | ✅ 复用 | `distillService.ts:374 validateProposal()` |
| 内置命令注册 | ✅ 复用 | `src/shared/commands/builtinPromptCommands.ts`（仿 `/init` 加一条）|
| **演示→结构化意图 prompt** | 🆕 新增 | 仿 Record&Replay：输入从哪来 / 每步动作 / 每步核对什么 / 成功判据 |
| **单会话蒸馏入口 service** | 🆕 新增 | `runDistillFromSession(sessionId)`——旁路频率门，整条 ledger 当唯一候选 |
| IPC 接线 + 测试 | 🆕 新增 | 仿 `src/main/ipc/diagnostics.ipc.ts:123` + vitest |

### 输出结构升级（Record&Replay 真正值钱处）
现有 distill 产出参数化 prompt 模板。演示模式应让 SKILL.md 带上**富结构**——把"这条多步任务的输入契约 + 关键检查点 + 完成判据"显式写进去，而非只存一句 prompt。这样"页面/路径变了、目标没变还能跑"。

### 工作量
S/M 量级：1 个 ADR + 1 service 入口 + 1 内置命令 + 1 prompt + IPC + 测试。**不碰 Computer Use**。

## 6. 需用户拍板的设计决策

**① 频率门怎么破**：现有蒸馏把"≥2 次才固化"代码化是核心安全设计（防 LLM 乱造资产）。演示模式必须 bypass（1 次就固化）。**建议**：不改挖掘路径，演示模式走独立 service 入口，用"显式用户调用"作替代信号门，且**强制 draft=true**（永远落草稿、绝不自动激活），用"人改"补"只演示一次可能不准"的风险。两条路径安全语义各自自洽。

**② 要不要做 / 何时做**：建议先做"当前会话一键蒸馏草稿"最小闭环，上线后看 Neo 自用真实复用率，再决定 profile 细分、跨会话拼接等重料。当前用户决定：**暂缓，只落本文档**。

## 7. 落代码前的硬门（as-built 铁律）

主控已亲读 `distillService.ts` + `distillPrompt.ts`，**确认** `/distill` 为挖掘驱动、频率门代码化。但 `emitter` / 草稿队列 / `skillCreate` 的接口仍是探查子 agent 的二手结论。**真要写代码前**须：(a) 独立 context 的 codex 交叉验证这几个模块接口；(b) 主控亲读关键文件。双核一致才动手，避免"以为能复用"写成接不上的代码。

## 源索引

- 原文：https://mp.weixin.qq.com/s/zJz_CaaGGuQcMAk3tjJq8g （firecrawl 抓取，2026-06-19）
- Neo 蒸馏系统：`src/main/services/skills/distillService.ts`、`src/main/agent/distillPrompt.ts`
- 会话轨迹读取：`src/main/services/core/databaseService.ts:462`、`src/shared/contract/sessionLedger.ts`
- 命令系统：`src/shared/commands/builtinPromptCommands.ts`、`src/main/services/commands/promptCommandService.ts`
- 相关已有设计：`docs/decisions/020-experience-distillation-redesign.md`、`docs/decisions/021-computer-use-cua-driver.md`、`docs/designs/ws5b-computeruse-mcp-security.md`
