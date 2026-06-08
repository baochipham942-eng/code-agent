# 经验沉淀重做 + 卸载/权限三层修复 设计

> 状态：设计待评审（proposed），评审通过后分两批执行
> 日期：2026-06-08
> 触发：一次 dogfood 会话暴露三个问题 —— ① 跑 3 次 bash 就被提议存成 `bash-bash-bash-bash` skill；② 全权限模式下"卸载 app"反复说"正在等你确认"却从不执行；③ 卸载目标（applet 等）没探索清楚。

## 背景

会话复盘发现三个问题，根因都已定位到代码：

1. **经验蒸馏产垃圾草稿**：`learningPipeline.ts` 用"同一工具序列出现 ≥3 次"做判据，命名直接拼工具名 → `bash-bash-bash-bash`。
2. **卸载死锁（三层叠加）**：模型只口头说"等确认"不调工具 + 删 `/Applications` 被命令分级硬毙 + 权限确认请求挂起后无法被后续消息恢复。
3. **探索半途而废**：是 ② 的下游（一直进不了"动手"状态）。

参照标杆 **Hermes Agent**（Nous Research 自改进 agent）的做法，结合 Voyager / Anthropic Agent Skills 的实证，确定重做方向。

---

# Part 1：经验沉淀重做（核心，第二批）

## 现状：两条路，一条产垃圾、一条是好种子

| 路径 | 文件 | 机制 | 问题 |
|------|------|------|------|
| **telemetry n-gram** | `src/main/agent/runtime/learningPipeline.ts` | 把连续成功的工具调用切 2~4 长 n-gram，同序列出现 ≥3 次即提议 | 纯频次、无语义、命名拼工具名 → **垃圾源头** |
| **LLM-review** | `src/main/lightMemory/conversationReview.ts` | LLM 读会话语义，`shouldCreate !== true` 就丢 | **已是 Hermes 雏形**，留用并升级 |

根因坐实：
- `learningPipeline.ts:90-150` `extractSuccessPatterns()` —— 唯一过滤是计数阈值（`SUCCESS_PATTERN_THRESHOLD = 3`，见 `src/shared/constants/memory.ts:141`）+ 去子序列，**无任何语义/价值过滤**。
- `learningPipeline.ts:162-167` `suggestSkillName()` —— `toolSequence.map(小写去符号).join('-')`，直接拼工具名。

## 标杆怎么做（实证依据）

| 维度 | Hermes Agent | Voyager | Anthropic Agent Skills | 我们当前 |
|------|-------------|---------|----------------------|---------|
| 触发 | 完成**非平凡任务**(5+ 工具调用)后 agent **反思** | 完成任务且通过自验证 | 注意"反复提供的 context" | 同序列 ≥3 次（频次） |
| 质量门 | LLM 反思即质量门 | **GPT-4 critic 自验证**（去掉性能掉 73%） | eval 驱动 + 人 review | 无 |
| 命名 | 任务意图（`backup-check`，动名词+宾语） | GPT-4 生成 docstring | gerund，**禁用** `helper/utils/tools` | 拼工具名 |
| 产物 | When-to-use / Procedure / Pitfalls / Verification | 可执行函数 + docstring | SKILL.md（<500 行）+ 渐进加载 | 一句 `bash → bash` |

**关键洞察**：Hermes 也有"工具调用次数"触发，但那只是"任务够复杂"的**入口闸**；真正决定"值不值得沉淀 + 叫什么名"的是后面那道 **LLM 反思**。我们的 bug 是把入口闸当成了全部判据，跳过了反思。

## 决策

**废掉 telemetry n-gram 自动提议，统一收口到 LLM-reflection 路（`conversationReview.ts`），并把它升级到 Hermes/Anthropic 规格。**

### 新判据（落地为代码）

按"硬性排除 → 反思命名 → 正向门槛"顺序：

**A. 入口闸（任务级，非动作级）**
- 任务已完成（沿用 conversationReview 现有的会话/turn 边界触发，不新造信号）
- **非平凡**：序列含 **≥2 种语义不同工具**，或多步之间有数据流依赖。纯单工具重复（全 bash / 全 read）直接不进。

**B. 反思门（替代频次判据）**
- LLM 读 trajectory，回答"完成了什么**可陈述的任务**"。
- 抽不出有意义任务名（落到 `run-bash` / `bash-bash` 这类）→ **沉默，不提议**。这一步取代旧的"够 3 次就提议"。

**C. 命名**
- 动名词 + 领域宾语（`migrating-database-schema`、`extracting-pdf-tables`）。
- **禁用泛词清单**（照搬 Anthropic avoid 列表）：`helper` `utils` `tools` `documents` `data` `files` `run-bash` 及任何"工具名拼接"形态 → 判定为"无法命名 → 不该成为 skill"。

**D. 产物**
- SKILL.md frontmatter（name/description）+ body：**When to use / Quick reference / Procedure / Pitfalls / Verification**。复用 ADR-002 已有的 SKILL.md 解析与渐进加载（L0 名字+描述 / L1 全文），不重造。

**E. 去重**
- 提议前查 `~/.code-agent/skills/` 已有同意图 skill 和 `skill-drafts/rejected.json`，命中则不重复提议（现有 reject 机制已具雏形）。

**F. 跨会话（正向加分，非硬门槛）**
- 同意图跨 ≥2 会话复现 → 可提升为"高置信，弱提示"；单会话内出现仍可提议但提示更克制。避免一刀切丢掉单会话内的真实有用流程。

### 止血（先于重做，可并入第一批）

- 给 telemetry 路加 feature flag（默认 **关**），立即停止刷垃圾草稿。重做落地后该路彻底移除。

## 钩子点

- `src/main/agent/runtime/learningPipeline.ts:90-167`：移除/旁路 `extractSuccessPatterns` + `suggestSkillName` 的自动提议（保留 failure-journal 部分，那块没问题）。
- `src/shared/constants/memory.ts:137-157`：`SUCCESS_PATTERN_THRESHOLD` 等成功序列常量随之废弃；新增反思相关配置。
- `src/main/lightMemory/conversationReview.ts`：升级 prompt（非平凡判定 / 意图抽取 / 禁用泛词 / SKILL.md 结构化产物）。
- `src/main/services/skills/skillDraftQueue.ts`：`enqueueSkillDraft` 增加命名禁用清单校验 + 去重校验。
- `src/renderer/components/features/chat/ChatInput/SkillDraftCard.tsx`：草稿卡展示从"工具序列"改为"任务意图 + when-to-use 摘要"。

---

# Part 2：卸载死锁三层修复（第一批）

## 三层根因（已坐实）

1. **模型层光说不做** —— `src/main/prompts/constitution/safety.ts`：宪法写"删除前请求确认""不确定就问"，模型理解成**口头**确认，于是生成"正在等你确认"文本，**不发起删除工具调用**。截图里没有权限卡片即此因。
2. **删 `/Applications` 被硬毙** —— `src/main/security/commandSafety.ts:394`：正则 `/rm\s+(-[rRf]+\s+)*[\/~]/` 把**任何删绝对路径的 rm 一律判 `critical`**，而 `allowed = highestRisk !== 'critical'`（commandSafety.ts:482）→ **直接拦截，到不了确认环节**。删 `/Applications/Claude.app` 在当前代码里永不可能成功。
3. **确认请求死锁** —— `src/main/agent/agentOrchestrator.ts:571-616`：权限请求挂在 `pendingPermissions` 等 Promise，用户下一条"删了吗?"开**新一轮 turn**，无逻辑 resolve 旧挂起请求，只能等 60s 超时 deny。

## 决策（依用户拍板：危险操作保留一次确认）

不改全权限默认值（`bypassPermissions.dangerous` 维持 `'prompt'`），改下面三处让"一次确认"真正能走通：

1. **safety.ts 措辞**：明确"删除/卸载这类操作**直接调用工具**，确认由工具层权限卡片负责；不要用文字代替确认、不要光说不做"。
2. **命令分级松绑误杀**（commandSafety.ts）：
   - "删一个明确具体路径"（如 `rm -rf /Applications/Xxx.app`、单一确定目标）→ 从 `critical 硬毙` 降为 `high → prompt 一次确认`。
   - **真正灾难性**才保留硬毙：`rm -rf /`、`rm -rf ~`、`rm -rf /*`、通配符删根/家目录、删当前目录 `.`。
   - 即收窄正则，把"目标明确的单路径删除"和"删根/家/通配"区分开。
3. **死锁修复**（agentOrchestrator.ts）：确认请求必须真的弹卡片；用户回应（点按钮或自然语言"确认/删"）能 resolve 挂起请求并恢复执行，而不是开新 turn 把旧请求晾死至超时。

## 钩子点

- `src/main/prompts/constitution/safety.ts:15-27`：改"需要确认的操作"段措辞。
- `src/main/security/commandSafety.ts:392-406, 482`：重写 rm 危险正则，分"目标明确删除(prompt)" vs "删根/家/通配(block)"；调整 `allowed` 判定。
- `src/main/agent/agentOrchestrator.ts:408-414, 571-616`：补"新消息 → resolve 挂起 permission"或"挂起期间不开新 turn"的恢复逻辑。
- `src/main/tools/toolExecutor.ts:496`：确认闸门读取当前权限模式（即便维持 prompt 语义，也要让分级正确传导）。

---

# Part 3：卸载/清理任务"先枚举后动手"（第一批，轻量）

## 决策

给卸载/清理这类任务一条软约束：**动手前先完整枚举目标再执行**。macOS app 卸载的标准目标清单：
- app 本体（`/Applications/Xxx.app`）
- URL Handler **applet**（AppleScript 注册器，需识别并说明）
- LaunchAgents / LaunchDaemons、登录项
- 应用配置/数据目录（如 `~/Library/Application Support/...`、`~/.code-agent`）
- CLI 二进制 vs 桌面 app 的区分

修了 Part 2 后探索会自然好转；此处只补"枚举完整性"的提示，可放进 safety.ts 或专门的卸载指引。

---

# 实施计划

## 第一批（止血 + 卸载修复，改动小、风险低）
1. telemetry 路加 flag 默认关（止血 ①）
2. safety.ts 措辞修复（②-1）
3. commandSafety 正则松绑误杀（②-2）
4. 确认死锁恢复逻辑（②-3）
5. 卸载枚举提示（③）
- 每点改完 `npm run typecheck`，逐点提交。

## 第二批（经验沉淀重做，需本设计评审通过）
1. conversationReview 升级（判据/命名/产物）
2. skillDraftQueue 加禁用清单 + 去重
3. SkillDraftCard 展示改造
4. 移除 telemetry n-gram 自动提议路
5. 升格为 ADR-020（accepted 后）

# 验证
- ①：构造"连跑 3 次 bash"会话 → 不再产生草稿；构造一个真实多步任务 → 产出意图命名 + 结构化 SKILL.md。
- ②：全权限模式下"卸载 X" → 模型直接调 rm 工具 → 弹一次确认卡 → 确认后真正删除（targeted path 不再被硬毙）；追问能恢复执行不死锁。
- ③：卸载任务先列全目标清单再动手。
- E2E 前注意清 `~/.code-agent/renderer-cache/active`（见根 CLAUDE.md 热更缓存坑）。

# 风险
- commandSafety 松绑是安全敏感改动：必须保证"删根/家/通配"仍硬毙，加单测覆盖正/负例。
- 移除 telemetry 路会少一个召回来源；靠升级后的 LLM-review 路 + 跨会话加分弥补。
- safety.ts 措辞改动可能影响其它破坏性操作的模型行为，需回归观察。

# 参考
- [Hermes Agent (YUV.AI)](https://yuv.ai/blog/hermes-agent) · [Hermes Skill 编写](https://www.glukhov.org/ai-systems/hermes/authoring-hermes-skill/)
- [Voyager (arXiv 2305.16291)](https://arxiv.org/abs/2305.16291)
- [Anthropic Agent Skills 最佳实践](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- 本项目 [ADR-002 Agent Skills 标准](../decisions/002-agent-skills-standard.md)
