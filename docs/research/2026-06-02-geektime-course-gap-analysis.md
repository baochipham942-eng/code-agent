# 极客时间课程 × Agent Neo 差距分析报告（第 1 期）

> 分析日期：2026-06-02
> 课程来源：《Claude Code 工程化实战》全 31 篇（黄佳，已完结）+《Agent 设计模式之美》第 00-05 篇（黄佳，更新中）
> 查证方式：8 个 Explore agent 并行扫描 Neo 仓库（v0.16.89, main @ 76b34502c），每条结论带代码路径证据，**未采信任何 memory/文档断言**
> 坐标系：**cowork 人机协作产品**（不按 IDE/编程助手品类评估）
> 上期报告：无（本期为第 1 期，编号从 GAP-001 起）

---

## 执行摘要

共产出 **22 条 findings**：

| 优先级 | 应该纠正 | 建议加强 | 合计 |
|--------|---------|---------|------|
| P0 | 3 | 2 | 5 |
| P1 | 3 | 6 | 9 |
| P2 | 2 | 6 | 8 |

另有 **13 项「已达标确认」**——课程点名的最佳实践 Neo 已正确实现（含若干此前 MOC 笔记中被误判为"空白区"的能力），见附录 A。

**三个最高优先级结论**：
1. Skill `allowed-tools` 在 inline 模式下被实现成"自动扩权"而非"限权边界"——与课程"工具隔离是安全设计不是功能设计"直接相悖（GAP-001）
2. PolicyEnforcer 整层是 dead code，从未进入工具执行链——结构上存在的护栏实际不生效（GAP-002）
3. AI SDK 迁移把 prompt caching 弄丢了——旧 claudeProvider 路径默认开启 caching，新 AI SDK 路径（当前主 loop 默认路径）完全没有 cache_control，这是迁移回归而非历史欠账（GAP-003）

---

## 一、追踪表（供下期对照）

| 编号 | 类型 | 优先级 | 标题 | 状态 |
|------|------|--------|------|------|
| GAP-001 | 应该纠正 | P0 | Skill allowed-tools 语义反转（inline 扩权 vs 限权） | FIXED (PR #192) |
| GAP-002 | 应该纠正 | P0 | PolicyEnforcer 整层 dead code | FIXED (PR #192) |
| GAP-003 | 应该纠正 | P0 | AI SDK 迁移丢失 prompt caching（旧路径有、新默认路径无） | FIXED (PR #192) |
| GAP-004 | 建议加强 | P0 | 多 Agent 流水线无反死循环策略 | OPEN |
| GAP-005 | 建议加强 | P0 | 跨会话经验沉淀链路被掏空（learningPipeline no-op） | OPEN |
| GAP-006 | 应该纠正 | P1 | Stop hook 是观察者不是完成闸 | OPEN |
| GAP-007 | 应该纠正 | P1 | 子代理/运行时配置未知字段静默忽略 | FIXED (PR #192) |
| GAP-008 | 应该纠正 | P1 | MCP 工具 schema 全量注入（与 native 工具 deferred 策略不一致） | FIXED (PR #194) |
| GAP-009 | 建议加强 | P1 | 大工具结果只截断不落盘 | FIXED (PR #194) |
| GAP-010 | 建议加强 | P1 | Git 上下文只注入 boolean | FIXED (PR #194) |
| GAP-011 | 建议加强 | P1 | 子代理缺 skills 全文预注入（课程"方向 A"） | OPEN |
| GAP-012 | 建议加强 | P1 | SubagentStop hook 拿不到子代理 transcript | OPEN |
| GAP-013 | 建议加强 | P1 | Generator-Critic 未集成为交付前自动验证 | OPEN |
| GAP-014 | 建议加强 | P1 | PostToolUse 缺 additionalContext 自修复闭环 | OPEN |
| GAP-015 | 应该纠正 | P2 | Hook 执行日志无密钥脱敏（auditLogger 已脱敏，hook 路径没有） | OPEN |
| GAP-016 | 应该纠正 | P2 | 子代理输出端无质量检查点（现有 checkpoint 仅是崩溃恢复） | OPEN |
| GAP-017 | 建议加强 | P2 | 评测中心缺 Harness 对照实验（ablation） | OPEN |
| GAP-018 | 建议加强 | P2 | 竞争假设/辩论编排模式缺失（基建已有） | OPEN |
| GAP-019 | 建议加强 | P2 | 无可嵌入 npm SDK（仅 HTTP API） | OPEN |
| GAP-020 | 建议加强 | P2 | CLI 缺 --max-turns / --allowedTools 无人值守约束旗标 | OPEN |
| GAP-021 | 建议加强 | P2 | Skill 命名空间 + monorepo 路径感知发现缺失 | OPEN |
| GAP-022 | 建议加强 | P2 | 插件缺远程分发机制（marketplace / git 安装） | OPEN |
| GAP-023 | 应该纠正 | P1 | system prompt budget 超限时静默丢弃 deferred-tools/skills 等注入块 | OPEN |

---

## 二、P0 详情

### GAP-001【应该纠正】Skill allowed-tools 语义反转

**课程出处**：
- 第 13 讲《Skills 架构定位与高级能力》："工具隔离的价值不在'能做什么'而在明确'不能做什么'——**是安全设计不是功能设计**"；"正文是知识（给 LLM 读），frontmatter 是约束（给编排器读，**强制执行**）"
- 第 05 讲评论区（作者纠错）："安全靠权限控制，不靠君子协定"

**Neo 现状**：
- `src/main/tools/modules/skill/skill.ts:81`（inline 模式）：`contextModifier.preApprovedTools = skill.allowedTools` —— allowed-tools 被用作**自动免审批白名单**（扩权），skill 执行期间 agent 依然可以调用列表外的任何工具
- `src/main/tools/modules/skill/skill.ts:124`（fork 模式）：`availableTools: skill.allowedTools` —— 这里才是限权语义（子代理工具集交集）
- 即：**同一个 frontmatter 字段，inline 模式是"功能设计"，fork 模式才是"安全设计"**。用户给 skill 写 `allowed-tools: [Read, Grep]` 以为圈住了边界，inline 执行时实际啥也没圈住

**建议动作**：
1. inline 模式给 skill 激活期间加 toolExecutor 级别的工具过滤：allowed-tools 非空时，列表外工具调用一律走"deny 或 ask"，与 fork 模式语义对齐
2. 在 Capability Center UI 标注每个 skill 的实际约束力（哪些字段是硬约束）
3. 补一个红队 eval case：给只读 skill 留 Bash，验证它能否写文件（课程 05 讲原版踩坑场景）

---

### GAP-002【应该纠正】PolicyEnforcer 整层 dead code

**课程出处**：
- 第 20 讲《Rules 规则系统深度剖析》："绝对底线规则不能只写在 rules 里……必须同时落到权限规则（deny）+ Hooks 硬约束"
- 第 05 讲评论区：`permissionMode: plan` 不是合法字段被静默忽略——"用户以为加了护栏其实没有"是课程点名的反模式

**Neo 现状**：
- `src/main/security/policyEnforcer.ts:90-174`：`checkCommand()` / `checkFilePath()` / `checkNetwork()` 完整实现（glob 路径匹配、域名白名单、命令黑名单）
- `src/main/tools/toolExecutor.ts:235-722`：实际执行链是 subagent policy → commandSafety → execPolicy → classifier → hook → 用户审批，**全程没有调用 PolicyEnforcer**
- `src/main/security/policyLoader.ts:36-187`：policy.toml 三层加载/合并逻辑也完整（deny 取并集、allow 高优先级覆盖），但加载出来的 policy 没人消费
- 后果：用户在 `/etc/code-agent/policy.toml` 或 `~/.code-agent/policy.toml` 写的 denied_paths / denied_commands / 网络白名单**实际不生效**——和课程点名的"假护栏"反模式同构

**建议动作**：
1. 在 toolExecutor 执行链 guard_fabric 层之后接入 `PolicyEnforcer.check*()`，DecisionTrace 补上 policy_enforcer 层（trace 契约里已经定义了这个层名）
2. 如果决定不要这层，删掉 policyEnforcer.ts + policyLoader.ts + policy.toml 文档，避免"看起来有但没有"
3. 接入后补集成测试：policy.toml 写 denied_path，验证 Edit 该路径被硬拦

---

### GAP-003【应该纠正】AI SDK 迁移丢失 prompt caching

**课程出处**：
- H3《源码泄露事故》：Claude Code 五项上下文工程优化之二——"静态/动态内容**分界标记 + 全局缓存**"，这是"同一模型在 Web UI 和 Claude Code 中表现天差地别"的原因之一

**Neo 现状**（主会话直接复核，修正了 Explore agent 的初步结论"完全没做"）：
- **旧路径有，且默认开启**：`src/main/model/providers/claudeProvider.ts:369-371` —— `promptCaching` 未配置时默认 `{ enabled: true, cacheSystem: true }`；`:448-461` 给 system prompt + 最后一个 tool 定义打 `cache_control: { type: 'ephemeral' }` 断点
- **新路径没有**：`src/main/model/adapters/aiSdkAdapter.ts` 无任何 cache_control 配置
- **而新路径是当前默认**：`src/main/agent/runtime/contextAssembly/inference.ts:56-72` —— 主 agent loop 对支持的 provider"默认 aisdk"，只有不兼容的 provider 才回落旧路径。即**当前默认执行路径上 caching 已经丢失**
- 两条路径共同缺口：都没有**消息历史断点**（对话增量缓存），这才是长会话省钱的大头
- 旁证：fork 子代理路径有独立的 `applyCacheControl()`（`src/main/agent/forkContext.ts:117-134`），说明团队懂这个机制，只是 AI SDK 迁移时没带过去
- 后果：Neo 是长会话 cowork 产品，系统提示词（6000 token 预算）+ 99 个工具 schema + 记忆索引每轮全量计费。cache hit 是 0.1 倍价格——**这是 AI SDK 迁移引入的成本回归**

**建议动作**：
1. **AI SDK 迁移（P2 阶段未完）收尾前必须补**：aiSdkAdapter 通过 AI SDK 的 `providerOptions.anthropic.cacheControl` 注入断点，与旧路径能力对齐
2. 两条路径都补消息历史断点：对话历史倒数第二轮加一个（标准三断点策略：system / tools / history）
3. 评测中心加成本对照：开/关 caching 跑同一 eval set，量化每会话节省
4. 多 provider 路由注意：仅对支持 caching 的 provider 注入

---

### GAP-004【建议加强】多 Agent 流水线无反死循环策略

**课程出处**：
- 第 07 讲《多任务并行探索与流水线编排》："避免死循环的关键原则：**Verifier 失败时回退到 Analyzer 而非让 Fixer 再试一次**"；"同阶段重试 >2 次或整体回退 >1 次就人工介入"
- 《Agent 设计模式之美》第 03 讲：Compound Error 公理四条路里的 fail fast——"Agent 世界的 Circuit Breaker，跳闸对象是推理轨迹"

**Neo 现状**：
- `src/main/agent/subagentExecutorTypes.ts`：SubagentConfig 只有 `maxIterations`（单子代理循环上限），无 per-stage retry limit
- `src/main/agent/parallelAgentCoordinator.ts` / `src/main/agent/multiagentTools/workflowOrchestrate.ts`：DAG/流水线调度无"失败回退到哪个节点"的路由规则，无"连续失败 N 次升级人工"的闸
- grep 全 `src/main/agent/` 无 verifier→analyzer 回退逻辑
- Neo 已知问题印证：memory 里记录过 MiMo text-first artifact 死循环、run 卡死——正是缺这层结构性约束的症状

**建议动作**：
1. 给 workflow/swarm 的 stage 定义加 `maxRetries`（默认 2）和 `onFailureRoute`（默认回退上游判断节点而非重试执行节点）
2. 全局加 circuit breaker：同一 run 内总回退次数 >1 触发暂停 + 通知用户（cowork 产品的"人工介入"就是弹给用户）
3. /goal 三层闸设计（已有方案）落地时把这条作为完成判定的硬约束

---

### GAP-005【建议加强】跨会话经验沉淀链路被掏空

**课程出处**：
- 《Agent 设计模式之美》开篇词：**"Agent 的价值跟它累积的经验等比，跟它今天有多聪明关系不大"**——不沉淀经验的 Agent 是"每天重新入职的聪明新人"；点名模式：Experience Replay、Failure Journal
- 第 05 讲（设计模式课）：Hermes 的程序性记忆——"把 trace 里的失败转成下一版 skill"
- 第 08 讲评论区：函数模型 + 文件持久化——"值得记的写成文件"

**Neo 现状**：
- `src/main/agent/runtime/learningPipeline.ts:26-39`：`runContinuousLearning()` 和 `runErrorPatternLearning()` 全是 no-op，注释写着 "Memory service removed"——**这条链路曾经存在，后来被摘除了**
- 已有的（别重复建）：
  - `src/main/planning/hooks/decisionHooks.ts:1-150`：3-Strike Rule，会话内错误历史注入（仅会话内有效）
  - `src/main/telemetry/telemetryCollector.ts:712-757`：失败工具调用全量持久化 + 20 类错误分类（原料齐全）
  - `src/main/lightMemory/consolidation.ts`：记忆整理 cron（但只整理用户写入的记忆，不从 telemetry 提炼）
- 缺口：telemetry 里躺着完整的失败数据，但没有任何机制把它变成下次会话的输入。Neo 处理过 100 个任务后，对这个仓库的了解和第 1 个任务时一样

**建议动作**：
1. 重建 learningPipeline：session 结束时从 telemetry 提取（a）重复出现的错误模式 →写入 Light Memory 的 failure journal 主题文件（b）成功的多步任务轨迹 → 生成 skill 草稿放入待确认队列
2. 利用已有的 consolidation cron 做整理，避免 journal 膨胀
3. 这是 cowork 产品的核心差异化（"越用越懂你的仓库"），建议作为下个 sprint 的 feature 而不是技术债

---

## 三、P1 详情

### GAP-006【应该纠正】Stop hook 是观察者不是完成闸

**课程出处**：第 16 讲《Hooks 高级模式》："Stop Hook 把质量保证从'事后检查'变成'交付前置条件'……检查通过了才算做完"；防死循环靠 `stop_hook_active` 字段

**Neo 现状**：
- `src/main/protocol/events/hookTypes.ts:22-44`：Stop 事件存在且不在 OBSERVER_ONLY_EVENTS 列表里（设计上允许做决策钩子）
- `src/main/hooks/hookManager.ts:249-262` + `src/main/planning/planningService.ts`：`triggerStop()` 触发后**不检查返回的 shouldProceed**，agent 该停还是停——事实上的观察者
- 无 `stop_hook_active` 等价的重试计数防死循环机制

**建议动作**：agent loop 的完成路径上消费 Stop hook 的 block 决策（block → 把 reason 注入上下文继续干活），配一个最多重试 1 次的安全阀。这是把 Neo 的 Hooks 从"通知系统"升级成"质量门"的关键一步。

---

### GAP-007【应该纠正】运行时配置未知字段静默忽略

**课程出处**：第 05 讲评论区（作者承认的纠错）：`permissionMode: plan` 不是合法 agent frontmatter 字段，被静默忽略——"用户以为加了护栏其实没有"

**Neo 现状**：
- `src/main/agent/subagentExecutorTypes.ts`：SubagentConfig 是严格 TS 接口，但运行时从 JSON/MD 加载的配置（用户写的 skill frontmatter、hooks.json、subagent 定义）遇到未知字段**无告警直接丢弃**
- `src/main/services/skills/skillParser.ts:78-104`：只校验 name/description 必填，未知 frontmatter 字段不报
- `src/main/hooks/configParser.ts`：同样无未知字段检测

**建议动作**：parser 层加 unknown-field warning（不必 reject，warn 即可），在 Capability Center 和日志里可见。一个 typo（`alowed-tools`）不该让用户的安全配置静默失效。

---

### GAP-008【应该纠正】MCP 工具 schema 全量注入

**课程出处**：第 17 讲评论区（作者纠正学员）：Claude Code 内置 MCP Tool Search——"工具总量超上下文 ~10%（约 10K token）标记 defer_loading: true，上下文只放工具名"——**官方 harness 层优化，默认开启**

**Neo 现状**：
- `src/main/services/toolSearch/deferredTools.ts:12-46`：native 工具做了 18 core + 79 deferred 分层 ✓
- `src/main/tools/dispatch/toolDefinitions.ts:158` + `src/main/mcp/mcpToolRegistry.ts:123-170`：**MCP 工具全量注入**——`getMCPClient().getToolDefinitions()` 无条件返回所有 server 的所有工具 schema
- 矛盾点：同一条"工具多了要 defer"的原则，Neo 对自家工具执行了、对 MCP 工具没执行。用户接 3 个大 MCP server 就能把上下文吃爆

**建议动作**：MCP 工具复用现有 ToolSearch deferred 机制——注册时只进 metadata 索引，schema 按需加载。Neo 自己的 deferredTools 基建是现成的，改动集中在 toolDefinitions.ts 的聚合逻辑。

---

### GAP-009【建议加强】大工具结果只截断不落盘

**课程出处**：H3 五项优化之四："大结果落盘——grep 几千行写临时文件，上下文只留摘要+路径引用"

**Neo 现状**：
- `src/main/context/layers/toolResultBudget.ts:116-161`：head+tail 截断（保 error 信号），2000 token/结果
- `src/main/tools/modules/shell/bash.ts:120` + `src/shared/constants/tools.ts:20`：Bash 30K chars 截断；`src/main/mcp/mcpToolRegistry.ts:620`：MCP 50K chars 截断
- 区别：截断 = 信息永久丢失，agent 想再看只能重跑命令；落盘 = 上下文留摘要+路径，agent 可以用 Read/Grep 回头查

**建议动作**：超阈值的工具结果写入 session 临时目录（`~/.code-agent/tmp/<session>/tool-results/`），截断文本尾部附加 `[完整输出已保存至 <path>，可用 Read/Grep 查看]`。配合已有的 read 工具零成本闭环。

---

### GAP-010【建议加强】Git 上下文只注入 boolean

**课程出处**：H3 五项优化之一："Git 上下文自动加载——注入分支名/commit/diff"

**Neo 现状**：`src/main/agent/messageHandling/contextBuilder.ts:47-57`——只注入 "Is directory a git repo: Yes/No"

**建议动作**：扩展 env block：当前分支、最近 5 条 commit oneline、working tree 是否 dirty（+ 改动文件数）。约 100-200 token 换 agent 对仓库状态的基础感知，cowork 场景下用户说"继续昨天的活"时尤其有用。

---

### GAP-011【建议加强】子代理缺 skills 全文预注入（方向 A）

**课程出处**：第 12 讲《Skills 与 SubAgent 配合实战》："**方向 A（SubAgent 含 Skill）最常用**——skills: 字段在子代理启动时把 SKILL.md 完整内容一次性注入"；"SubAgent 中 skills 字段是全量加载，不是渐进式披露"

**Neo 现状**：
- `src/main/agent/subagentExecutorTypes.ts:10-27`：SubagentConfig 无 `skills` 字段
- Neo 只有方向 B：`src/main/tools/modules/skill/skill.ts:96-134` 的 `context: fork`（Skill 触发时派生子代理）
- 即课程说"最常用"的那个方向 Neo 没有：无法定义一个"预装了某领域知识"的专家子代理

**建议动作**：SubagentConfig 加 `skills?: string[]`，spawn 时把对应 SKILL.md 全文拼进子代理 system prompt。与 GAP-001 的 fork 限权语义配合，就是课程的"知识注入 + 能力工具"正交分离。

---

### GAP-012【建议加强】SubagentStop 拿不到 transcript

**课程出处**：第 16 讲：SubagentStop 独有 `agent_transcript_path`，"验收能看'子代理怎么得出结论'而非只看最终结果"

**Neo 现状**：`src/main/hooks/hookManager.ts:474-489`——SubagentStop 上下文只有 subagentType / response（最终输出字符串）/ sessionId / timestamp

**建议动作**：Neo 的 telemetry 本来就持久化了子代理全过程（swarmTraceWriter.ts），把 trace 查询入口（session id + agent id）塞进 SubagentStop 的 hook context 即可，不需要新建数据。

---

### GAP-013【建议加强】Generator-Critic 未集成为交付前自动验证

**课程出处**：《Agent 设计模式之美》开篇词：Generator-Critic 模式——"利用'找 bug 比写无 bug 代码容易'的不对称性"；第 02 讲：反思脉缺失 → 错误失控

**Neo 现状**：
- `src/main/tools/modules/planning/explore.ts:88-100`：code-review 子代理存在，但是 opt-in 能力（用户/模型显式调用才跑）
- agent loop 的交付路径上无自动 critic 环节

**建议动作**：给"修改了 ≥N 个文件"或"高风险操作"的 run 加可配置的交付前 critic：完成前自动派 review 子代理（复用现有 code-review 定义），发现 Critical 问题则阻塞交付并注入上下文。与 GAP-006（Stop hook 门控）共用一套机制实现。

---

### GAP-014【建议加强】PostToolUse 缺自修复闭环

**课程出处**：第 15 讲："PostToolUse 的 additionalContext 构成闭环反馈——Hook 观察到问题→注入上下文→Claude 主动修复，把质量检查变成自动修复循环"

**Neo 现状**：`src/main/hooks/promptHook.ts:147` + `src/main/hooks/hookManager.ts:602`——只有内置 hook 模板（SessionStart/PreCompact）能注入 context；用户配置的 PostToolUse hook 的输出只能记日志，不会回流到对话

**建议动作**：给 hook 返回结构加 `injectedContext` 字段并在 agent loop 消费（下一轮 user message 前插入）。例：Write 后 hook 跑 lint 失败 → lint 错误注入上下文 → agent 自己修。

---

## 四、P2 详情

### GAP-015【应该纠正】Hook 执行日志无密钥脱敏

**课程出处**：第 15 讲："生产审计必须脱敏：敏感路径只记 path 不记 content、正则掩码（AKIA/sk-/长十六进制）、chmod 600"

**Neo 现状**：
- `src/main/security/auditLogger.ts:355-427`：审计日志的 params 有 sanitize ✓
- `src/main/hooks/hookExecutionEngine.ts` / `hookManager.ts`：hook 执行路径的日志（tool_input 整体传给 hook 并记录）**无掩码**——两条日志路径标准不一致

**建议动作**：把 auditLogger 的脱敏函数抽成共享工具，hook 日志路径复用。

### GAP-016【应该纠正】子代理输出端无质量检查点

**课程出处**：第 04 讲生产化四挑战之一："状态性级联放大——每个 Agent 输出端设检查点"

**Neo 现状**：`src/main/agent/parallelAgentCoordinator.ts:130-152`——checkpoint 是崩溃恢复快照，不是质量门；子代理输出（free text）直接传下游，无 schema 校验（`subagentExecutorTypes.ts:29-51` 只有 Result 包装层的类型约束）

**建议动作**：workflow stage 定义支持可选的 `outputSchema`（JSON Schema），上游输出不符合时重试或报错，而不是让下游拿脏数据瞎干。

### GAP-017【建议加强】评测中心缺 Harness 对照实验

**课程出处**：H2："同一模型在不同 Harness 中的差距 > 不同模型在同一 Harness 中的差距"——建议补"固定模型、变 Harness 配置"的对照实验

**Neo 现状**：`src/main/evaluation/experimentAdapter.ts`——实验跑的是完整 harness，无配置变量扫描（context 压缩开/关、工具集裁剪、hook 开/关的 A/B）

**建议动作**：实验配置加 harness 参数维度。这也是求职叙事素材：量化证明"Neo 的护城河在 Harness 工程而非模型选型"。

### GAP-018【建议加强】竞争假设/辩论编排模式

**课程出处**：第 08 讲 Agent Teams 四协作模式之一："竞争假设——多 Teammate 持不同假设互相挑战推翻，避免锚定效应"；08b 讲："执行依赖 vs 认知依赖是分水岭"

**Neo 现状**：
- 基建已有：`src/main/agent/spawnGuard.ts:56-73` 的 AgentMessage 队列 + `parallelAgentCoordinator.ts:90-95` 的共享 findings/decisions Maps
- 缺编排模式：无"多假设 → 互相质疑 → 幸存者胜出"的内置工作流

**建议动作**：作为 dynamic workflow 的一个预置脚本模板实现（不用动核心架构），用于 debug/根因分析场景。优先级低于 GAP-004（先把反死循环做了）。

### GAP-019【建议加强】无可嵌入 npm SDK

**课程出处**：第 21/22 讲：Agent SDK 双入口（query() 一次性 / Client 有状态）；"SDK 就是把 CC 变成你的 Runtime Harness"

**Neo 现状**：`package.json` 无 exports 字段；唯一可编程入口是 webServer HTTP API（40+ 路由，含 SSE 流式）。CLI 的 CLIAgent 类（`src/cli/adapter.ts:35-125`）是内部实现未导出

**建议动作**：cowork 桌面产品的 SDK 需求弱于 CC，不急。若做：把 CLIAgent 抽成 `@code-agent/sdk` 包，query()/Client 双入口照搬课程设计。

### GAP-020【建议加强】CLI 缺无人值守约束旗标

**课程出处**：第 19 讲："--allowedTools 和 --max-turns 是无人监管环境的第一道安全防线"

**Neo 现状**：`src/cli/commands/run.ts`——run 一次性执行/stdin/JSON 输出/exit code 都有 ✓，但无 --max-turns、--allowedTools、--permission-mode 旗标

**建议动作**：run 命令补这三个旗标，映射到已有的 maxIterations / availableTools / permissionMode 内部参数（全是现成能力，只缺 CLI 暴露）。

### GAP-021【建议加强】Skill 命名空间 + monorepo 发现

**课程出处**：第 09 讲：Plugin Skills 用 `plugin-name:skill-name` 命名空间；monorepo 子目录自动发现 `.claude/skills/`

**Neo 现状**：
- `src/main/services/skills/skillDiscoveryService.ts:82`：flat namespace（Map<name, skill>），同名冲突靠加载顺序覆盖
- `skillDiscoveryService.ts:110-124`：只扫 workingDirectory 根，不感知子目录

**建议动作**：plugin 来源的 skill 加 `<plugin>:` 前缀；discovery 支持按当前操作文件路径向上查找最近的 `.code-agent/skills/`。

### GAP-022【建议加强】插件缺远程分发

**课程出处**：第 23 讲：插件价值 = "约定变约束" + Git 分发 + marketplace；"30 分钟入职培训变成 30 秒安装命令"

**Neo 现状**：`src/main/plugins/pluginLoader.ts:88-103`——manifest（plugin.json）+ 目录约定 + 版本字段都有 ✓，但只能从本地 `~/.code-agent/plugins/` 加载，无 install-from-git/registry

**建议动作**：先做 `code-agent plugin install <git-url>`（git clone 到 plugins 目录 + manifest 校验），marketplace 等有多用户需求再说。

---

## 五、阶段二 E2E 发现的新增项

### GAP-023【应该纠正】system prompt budget 超限时静默丢弃能力发现块

**发现出处**：阶段二 E2E 验收（2026-06-02，非课程内容）——webServer headless 真实链路实测

**Neo 现状**：
- `src/main/agent/runtime/contextAssembly/messageBuild.ts` 的 `appendPromptBlockWithinBudget`：system prompt budget 默认 6000 token（可用 `CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS` 覆盖）
- 用户记忆注入（Light Memory 索引 + soul，实测 ~4-5K token）吃掉大部分预算后，**后续追加的所有块按序被静默丢弃**：session metadata / memory hint / plugins / skills / recent conversations / **deferred-tools**
- 实测日志：`Skipping deferred tools: system prompt budget would be 7952/6000 tokens`，只有 WARN 级日志，用户/模型均无感知
- 后果：**deferred 工具发现机制在重记忆环境下实际失效**——模型不知道有哪些可加载工具（含全部 MCP 工具索引），skills 索引也不可见，agent 能力大幅缩水且无任何报错

**建议动作**：
1. budget 动态化：按模型上下文窗口比例（如 8-12%）而非固定 6000，大窗口模型不该被小预算卡死
2. 注入块优先级排序：能力发现类块（deferred-tools / skills 索引）优先级应高于 recent conversations / memory hint 这类锦上添花的块——现在是先到先得
3. 丢弃可见化：被丢弃的块在 context health 面板展示，不只是 debug log

---

## 附录 A：已达标确认（含对此前误判的纠正）

以下课程点名的最佳实践，本次代码查证确认 Neo **已正确实现**。其中标 ⚠️ 的条目此前在课程笔记 MOC 中被误判为"Neo 的空白区"，以代码为准：

| # | 课程出处 | 最佳实践 | Neo 证据 |
|---|---------|---------|---------|
| 1 ⚠️ | 第 19 讲 | Headless 一次性执行 + stdin 管道 + JSON/NDJSON 输出 + exit code | `src/cli/commands/run.ts:64-276`（run/exec 命令）、`src/cli/output/json.ts:29-120` |
| 2 ⚠️ | 第 19 讲 | 判定解析不用自然语言 grep（sentinel/结构化输出） | `src/main/evaluation/trajectory/attribution/llmAttributor.ts:100-173`——结构化 JSON schema 校验，比课程的 sentinel token 方案更强 |
| 3 ⚠️ | 第 20 讲 | bypassPermissions 不绕过 deny | `src/main/tools/toolExecutor.ts:334-371`——commandSafety 关键拦截在权限模式判断之前；bypass 模式反而**启用** OS 沙箱（`src/main/tools/modules/shell/bash.ts`） |
| 4 | 第 20 讲 | deny → ask → allow 评估顺序，deny 优先 | `src/main/tools/toolExecutor.ts:331-487` 执行链 + `src/main/security/policyLoader.ts:81-107`（deny 取并集不可被低层覆盖） |
| 5 | H3 | 文件读取去重（防重复注入） | `src/main/agent/runtime/contextAssembly/shared.ts:15-29`（mtime 缓存） |
| 6 | H3 | Self-Healing Memory 写纪律（先写数据后更新索引） | `src/main/tools/modules/lightMemory/memoryWrite.ts:157-158` |
| 7 | 第 02 讲 | paths: 条件作用域规则 | `src/main/config/rulesLoader.ts:102-106`（picomatch 路径匹配） |
| 8 | 第 02 讲 | 记忆体检（token 期望模型） | `src/main/lightMemory/consolidation.ts` + `memoryEntryRuntime.ts:184-234`（按 status/scope/age 打分整理） |
| 9 | 设计模式课 05 讲 | 状态账本（append-only event log + replay） | `src/main/telemetry/telemetryCollector.ts:211-1000` + `src/main/evaluation/replayService.ts`（SQLite 全量持久化可回放） |
| 10 | 设计模式课 00 讲 | 错误堆栈永不压缩 | `src/main/context/compactionService.ts:109-120`（Survivor Manifest 保留 errors） |
| 11 | 第 15/16 讲 | Hook 退出码三态语义 / updatedInput 改写参数 / async hook / HTTP allowedEnvVars 白名单 | `src/main/hooks/scriptExecutor.ts:60-159`、`httpHookExecutor.ts:127-134`、`hookExecutionEngine.ts:77-82`——Neo 19 个 hook 事件比 CC 的 17 个还全 |
| 12 | 第 18 讲 | Read-before-Edit 强制 + 结构化原生工具 + Bash 输出 token 控制 | `src/main/tools/fileReadTracker.ts` + `multiEdit.ts:116` + `src/shared/constants/tools.ts` |
| 13 | 第 17 讲 | MCP 三传输协议 + Resources/Prompts + 输出上限 + env 白名单 | `src/main/mcp/mcpTransport.ts:94-141`、`mcpToolRegistry.ts:144-155, 620-648` |

**对课程 MOC 的修正**：《ClaudeCode工程化实战》MOC 的"真增量按优先级"第 1 条写"Headless/CI-CD/对外 SDK 是 Neo 最大的空白区，CLI 补 -p 是最低成本起点"——**此判断过时**。代码证实 run 命令已是完整 headless 入口，真正缺的只是 CI 约束旗标（GAP-020）和 SDK 包装（GAP-019），均为 P2。

---

## 附录 B：查证方法说明

- 8 个 Explore agent 并行扫描，主题分组：上下文/记忆、子代理编排、Skills、Hooks、权限治理、CLI/SDK、工具/MCP/LSP、可观测/评测
- 每个 agent 被要求对每条 claim 给出 IMPLEMENTED / PARTIAL / NOT_FOUND + 代码路径证据；NOT_FOUND 必须说明查过哪些目录
- agent 结论需主会话二次裁决的本期共 2 处，均已修正：
  1. skills 的 frontmatter 约束力（agent 内部证据矛盾）→ 主会话读 `skill.ts` 裁决，产出 GAP-001
  2. prompt caching"完全没做"（agent 只查了 aiSdkAdapter 漏了旧 provider 路径）→ 主会话补 grep 发现旧路径有且默认开启，改判为"迁移回归"，见 GAP-003
- 行号基于 main 分支 commit 76b34502c（2026-06-02），后续代码变动可能导致行号漂移，以文件路径 + 函数名为准
