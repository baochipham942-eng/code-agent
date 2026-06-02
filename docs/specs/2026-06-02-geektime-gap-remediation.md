# 2026-06-02 极客时间课程差距修复 Spec（四阶段 as-built）

> 状态: accepted
> 时间窗: 2026-06-02（四阶段同日完成）
> 依据: [课程差距分析报告](../research/2026-06-02-geektime-course-gap-analysis.md)（23 条 findings）、[修复计划](../plans/2026-06-02-geektime-gap-remediation-plan.md)
> 关联架构: [agent-core.md](../architecture/agent-core.md)、[tool-system.md](../architecture/tool-system.md)、[multiagent-system.md](../architecture/multiagent-system.md)、[dynamic-workflow.md](../architecture/dynamic-workflow.md)、[ipc-channels.md](../architecture/ipc-channels.md)、[评测系统指南](../guides/evaluation-system.md)

## 目标

对照极客时间《Agent 设计模式之美》等课程逐条审计 Neo 的工程实现（23 条 findings），按"假护栏 → 上下文经济 → 质量闭环 → 经验沉淀"四个阶段修复 17 条，把课程中的关键设计模式落成 Neo 的产品合同：

1. **拆假护栏（阶段一，PR #192）**：让"看起来有保护实际没有"的安全机制真实生效——skill 限权、policy 引擎、配置校验、prompt caching。
2. **上下文经济（阶段二，PR #194）**：把"塞进上下文的每个 token"变成可解释的决策——MCP 工具索引化、大结果落盘、git 状态注入。
3. **质量闭环（阶段三，PR #196）**：把"跑完了"升级为"跑对了"——Stop hook 完成闸、PostToolUse 自修复、workflow 反死循环、stage 输出校验、交付前 critic、prompt 预算治理。
4. **经验沉淀（阶段四，本分支）**：让 Neo "越用越懂这个仓库"——failure journal 跨会话避坑、skill 半自动蒸馏、子代理专家化、harness 对照实验。

## 非目标

- 不做 GAP-018（竞争假设/辩论编排）、GAP-019（npm SDK）、GAP-020（CLI 无人值守旗标）、GAP-021（skill 命名空间）、GAP-022（插件远程分发）——cowork 单机产品现阶段不需要。
- 阶段四 skill 蒸馏**不做全自动入库**——课程原文是全自动，修正版降级为半自动确认制（草稿队列 + 用户确认），质量优先于自动化程度。
- 不重建向量/embedding 记忆系统；经验沉淀完全建立在 File-as-Memory（Light Memory）架构上。

## 产品合同

### 0. GAP → 阶段 → 实现映射

| GAP | 阶段 | 主题 | 关键 commit | 关键文件 |
|-----|------|------|------------|----------|
| 002 | 一 | PolicyEnforcer 接进工具执行链 | 833d9187b | security/policyEnforcer.ts, agent/runtime/toolExecutionEngine.ts |
| 001 | 一 | skill allowed-tools 限权边界 | 086919ae8 | tools/modules/skill/skill.ts, tools/toolExecutor.ts |
| 007 | 一 | 配置未知字段告警 | bd05ca1d7 | hooks/configParser.ts |
| 003 | 一 | AI SDK 路径恢复 Anthropic prompt caching | bdba69a35 | model/adapters/aiSdkAdapter.ts |
| 008 | 二 | MCP 工具名索引（deferred 化） | 1b4ae6230 | mcp/mcpToolRegistry.ts, tools/dispatch/toolDefinitions.ts |
| 009 | 二 | 工具结果落盘（spill before truncate） | 055cf075b, 8f175859d | utils/toolResultSpill.ts |
| 010 | 二 | git 分支/commit/dirty 注入 env block | 409f2508b | agent/messageHandling/contextBuilder.ts |
| 006+014 | 三 | Stop hook 完成闸 + PostToolUse additionalContext | 4d9cea9f5 | hooks/hookManager.ts, hooks/scriptExecutor.ts, agent/runtime/messageProcessor.ts |
| 013 | 三 | Generator-Critic 交付前验证 | a06dc4562 | agent/deliveryCritic.ts |
| 004 | 三 | workflow stage 反死循环 | bad320851 | agent/multiagentTools/workflowOrchestrate.ts |
| 016 | 三 | workflow stage outputSchema 校验 | a313cde0e | 同上 + agent/structuredOutput.ts |
| 012+015 | 三 | SubagentStop trace 入口 + hook 日志脱敏 | 349cdb39f | agent/subagentExecutor.ts, hooks/hookExecutionEngine.ts |
| 023 | 三 | prompt 块优先级 + 丢弃可见化 + 预算动态化 | 820cfd6a6, 2a6fc8d65 | agent/runtime/contextAssembly/messageBuild.ts, shared.ts |
| 005 | 四 | 经验沉淀管线重建（修正版） | 022a41086, 66c05b1e2 | agent/runtime/learningPipeline.ts, lightMemory/failureJournal.ts, services/skills/skillDraftQueue.ts |
| 011 | 四 | 子代理 skills 全文预注入（方向 A） | 1af58c499 | services/skills/subagentSkillInjection.ts, agent/subagentExecutor.ts |
| 017 | 四 | 评测中心 harness 对照实验 | 48af111d9 | testing/harnessComparison.ts, ipc/evaluation.ipc.ts |

（文件路径省略 `src/main/` 前缀。）

### 1. 安全与护栏合同（阶段一）

- **skill allowed-tools 是限权边界，不是扩权白名单**：任何来源的 skill 激活后，`allowed-tools` 之外的工具调用强制走用户审批（`runtimeContext.skillToolBoundary`）；仅 builtin/plugin skill 享受边界内免审批。
- **policy.toml 真实生效**：PolicyEnforcer 接进 ToolExecutor 执行链，`denied_path` 等规则命中即硬拦，DecisionTrace 出现 `policy_enforcer` 层。
- **配置写错有反馈**：hooks 等运行时配置出现未知/拼错字段时输出 warning，不再静默忽略。
- **prompt caching 不因架构迁移退化**：AI SDK provider 路径补回 Anthropic `cache_control`，同会话多轮 `cache_read_input_tokens > 0`。

### 2. 上下文经济合同（阶段二）

- **MCP 工具按需加载**：系统提示词中 MCP 工具只有名字索引（`mcp__<server>__<tool>`），schema 通过 ToolSearch 加载后才可调用，与 native 工具 deferred 策略一致。
- **大工具结果可回查**：超阈值输出先落盘到 `~/.code-agent/tmp/<session>/tool-results/` 再截断，上下文留摘要+路径，agent 用 Read/Grep 回查，不重跑命令。
- **git 状态自动可见**：env block 携带当前分支、最近 commits、dirty 文件数（带 TTL 缓存）。

### 3. 质量闭环合同（阶段三）

- **Stop hook 是完成闸**：返回 block 时 agent 继续工作（带 `STOP_HOOK.USER_MAX_RETRIES` 安全阀防无限循环 + `stopHookActive` 标记防套娃）；hook 协议兼容 Claude Code 的 `decision` / `hookSpecificOutput.additionalContext` 格式。
- **PostToolUse 形成自修复闭环**：hook 输出注入下一轮上下文（写文件 → lint 失败 → agent 自动修）。
- **workflow 不死循环**：声明式 stage 失败按 `maxRetries` → `onFailureRoute` 回退 → circuit breaker 跳闸三层兜底；stage `outputSchema` 校验失败同样进入该链。
- **交付前有质检**（opt-in）：`CODE_AGENT_DELIVERY_CRITIC=1` 时交付前跑一轮独立 critic，发现 Critical 问题阻塞交付；critic 故障默认放行。
- **prompt 预算可解释**：预算 = max(6000, 模型窗口×10%)；能力发现块优先于锦上添花块；被丢弃的块进 `ContextHealthState.droppedPromptBlocks` 并在 UI 可见。

### 4. 经验沉淀合同（阶段四）

#### Failure Journal（全自动）

- session 结束时 `learningPipeline.runSessionEndLearning()`（fire-and-forget）从 `telemetry_tool_calls` 提取失败模式：按 `toolName + errorCategory + 归一化错误消息`（数字→N、引号内容→"..."、截断 100 字符）分组，累计 ≥3 次的模式合并写入 Light Memory `failure-journal.md`（跨会话累加计数，上限 30 条按 lastSeen 淘汰）。
- 新 session 构建 system prompt 时无条件注入 `<failure_journal>` 块（最多 15 条最新模式），让 agent 在执行同类操作前看到已知坑。
- journal 是普通 Light Memory 文件，长期整理复用既有 consolidation cron。

#### Skill 蒸馏（半自动确认制）

- 同一 session 内成功工具序列（n-gram 长度 2-4）出现 ≥3 次 → 生成 SKILL.md 草稿进 `~/.code-agent/skill-drafts/` 待确认队列（与 `skills/` 平级，不会被 discovery 扫描）。
- emit `skill_draft_pending` 事件（`AgentEvent` union 成员）→ run SSE 流 → renderer `SkillDraftNotifications` 卡片弹用户确认。
- **严禁自动入库**：只有用户通过 `skill:draft:confirm` 确认才移入 `~/.code-agent/skills/`；`skill:draft:reject` 删除草稿并把 patternKey 记入 rejected ledger（同一模式不再重复打扰）。

#### 子代理 skills 预注入（课程"方向 A"）

- `SubagentConfig.skills?: string[]`（同步加到 `AgentCore` / `CoreAgentConfig` / agent .md frontmatter）：spawn 时把对应 SKILL.md 全文拼进子代理 system prompt（`<preloaded_skills>` 块，全量加载非渐进式披露）。
- 与 GAP-001 限权语义正交：注入 skill 只加知识，不扩张 `availableTools` 权限边界。

#### Harness 对照实验

- `HarnessVariantConfig` 三维度：`contextCompression`（压缩开/关）/ `hooksEnabled`（hooks 开/关）/ `toolMode`（all 全量 | deferred 延迟加载）。
- `runHarnessComparison`：固定模型串行跑每个变体，每变体一条 experiment 记录（预生成 runId），`config_json.harness` 落维度，实验名 `harness-<variant>-<date>` 便于跨实验对比。
- 课程 H2 论点的量化工具："同一模型在不同 Harness 中的差距 > 不同模型在同一 Harness 中的差距"。

## 数据和 IPC 合同

| 合同 | 内容 |
|------|------|
| Light Memory 新文件类型 | `failure-journal.md`（type: failure-journal, source: learning-pipeline），机器可读 JSON 嵌在 `<!-- FAILURE_JOURNAL_JSON: ... -->` 注释里 |
| skill 草稿队列 | `~/.code-agent/skill-drafts/<id>/{SKILL.md, draft.json}` + `rejected.json` ledger |
| AgentEvent 新成员 | `skill_draft_pending`（data: `SkillDraftPendingData`）；事件必须走 `ctx.onEvent` → run SSE 流，**不能走 EventBus**（EventBridge 在 webServer 架构下不会启动） |
| experiments 表 | `config_json.harness` 携带 `HarnessVariantConfig`；实验名前缀 `harness-` 标识对照实验 |
| 新 IPC 通道 | `skill:draft:list/confirm/reject`、`evaluation:run-harness-comparison`、`evaluation:list-experiments`（webServer 自动暴露为 `POST /api/<channel 冒号转斜杠>`） |
| 新常量 | `LEARNING_PIPELINE`（shared/constants/memory.ts）、`HarnessVariantConfig`（testing/types.ts） |
| MemoryInjectionBlockType 新成员 | `failure_journal`（注入可观测） |

## 验收矩阵

四个阶段各自跑过 E2E 验收（webServer headless + zhipu/glm-5 真实链路），证据记录在[修复计划](../plans/2026-06-02-geektime-gap-remediation-plan.md)各阶段验收标准小节：

| 阶段 | E2E 验收 | 结果 |
|------|---------|------|
| 一 | 红队 case：只读 skill 调 Write 被拦 / policy.toml denied_path 硬拦 / typo 字段 warning / cache_read_input_tokens > 0 | 4/4 |
| 二 | MCP 名字索引 / 大输出落盘+回查 / env block 带 git 状态 | 3/3 |
| 三 | Stop hook block→继续→放行 / PostToolUse lint 反馈自动修复 / 反死循环 / deferred-tools 默认预算存活 | 5/5 |
| 四 | 失败×3→journal 落盘→新 session 注入 / 成功×3→草稿+确认事件+不自动入库+confirm/reject 闭环 / 固定模型双变体对照实验落 DB | 4/4 |

全量回归：711 测试文件通过，12 个失败全部为 origin/main pre-existing（runtimeAssetsManifestSigning / agentDefinition / promptRegression / toolExecutor.mcpDirect），零新增失败。

## 开放风险

- **failure journal 注入是无条件的**：journal 非空即注入（≤15 条），重失败历史的环境会固定占用少量 prompt 预算；如膨胀可改为按当前任务相关性过滤。
- **skill 蒸馏的 n-gram 提取是确定性模板**：不走 LLM 蒸馏，草稿质量是"工作流骨架"级别，依赖用户确认时编辑；后续可在确认 UI 里接 LLM 润色。
- **harness 对照实验的 contextCompression 维度靠全局单例临时覆盖**：autoCompressor 是进程级单例，run 期间覆盖、结束恢复；评测串行跑没问题，若未来改并行需要 per-loop 压缩配置。
- **EventBridge 在 webServer 架构下从不启动**：这是本工程 E2E 发现的存量架构事实（webServer.ts:417 注释也承认）。所有"main → renderer 出带外事件"的需求都必须走 `ctx.onEvent`（run 流）或 `broadcastToRenderer`（windowBridge → SSE），EventBus publish 在生产架构下是无人消费的。建议后续要么把 EventBridge 接进 webServer bootstrap，要么删掉这条死通路。
- 4 个 pre-existing 测试文件失败仍未修（与本工程无关，详见修复计划阶段三小节）。
