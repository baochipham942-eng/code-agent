# Tool Platform / Agents 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇**大部分 DEFERRED**：
> - ✅ 仅保留 P0 的 **统一 `AgentFailureCode` + 重启恢复语义 → 并入 WP-F**（与 shell 篇的重启恢复合并）。
> - ⏸️ **Capability Matrix / Agent Tree 状态 API / worktree merge queue / policy-as-code / ToolSearch 语义索引 → DEFERRED**：控制面大件，工具还没硬化前先做控制面是倒置；本篇自己也警告"容易变成又一份重复 registry"，这个自觉对。
> - `durable subagent ledger` 持久化的是统一 `EvidenceRef` + agent 元数据（见 WP-A），不另发明证据形状。
> 下文 P0/P1/P2 保留作 depth 参考，**近期开工只取"AgentFailureCode + 重启恢复"，其余按集成文档押后**。

## 判断

Neo 在 Tool Platform / Agents 这条线上已经有一套成形底座：deferred tools、ToolSearch、MCP lazy-load、hooks、权限继承、subagent、parallel coordinator、workflow runtime、worktree isolation 都有实现和测试支撑。

下一阶段的主要问题不是继续增加工具数量，而是把这些能力收成一个可解释、可审计、可恢复的控制面。工具越多、任务越长、权限越复杂，模型和用户都需要清楚知道：当前有哪些能力可用、为什么可用、需要什么权限、被哪些 hook 影响、子 agent 失败后归因到哪里、worktree 产物由谁决策。

长期方向应当是把 Neo 从“工具列表 + 子 agent 调度器”推进到“工具和 agent 的运行平台”。这个平台的核心资产是 Capability Matrix、Agent Tree、权限继承审计、hook 可观测、durable subagent ledger 和 worktree 产物闭环。

## 目标形态

- 用户和父线程能看到统一的 Tool / Agent Capability Matrix。矩阵覆盖 builtin deferred tools、MCP tools、skills、agent roles、workflow primitives，并展示 loaded / lazy / error / unavailable、schema 状态、canonical invocation、权限边界、hook 覆盖、适用 agent、worktree 策略和失败语义。
- ToolSearch 不只返回“找到了哪个工具”，还解释“为什么推荐这个工具、它现在是否可调用、还差什么加载或权限、调用后会触发哪些边界”。
- MCP lazy-load 有可见状态。父线程能看到 lazy server 是否被查询命中、是否启动成功、有哪些工具注册进 ToolSearch、失败时是配置问题、进程问题、网络问题还是权限问题。
- 子 agent 失败语义统一。spawn、parallel、workflow、background 子任务都使用一组稳定 result code，父线程不用分别理解 `cancellationReason`、`failureRouting`、SpawnGuard status、parallel skipped、workflow stage error。
- Agent Tree 成为长任务主视图。每个 agent 节点展示角色、状态、预算、工具权限、hook 事件、worktree 路径、最后进展、输出摘要、失败原因和可执行动作。
- worktree 产物进入显式闭环。coder 子 agent 产生变更后，父线程能查看 diff、测试结果、patch safety net、保留路径、丢弃动作和后续合并决策。
- hooks 从底层事件系统升级为可观测策略层。PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop、PermissionRequest、PermissionDenied、StopFailure 等事件应出现在工具执行和 agent 时间线里。
- 权限继承可审计。父 agent、child context、MCP tool、workflow stage、hook decision 对同一次动作的影响需要能串起来看。
- durable subagent ledger 承担后台任务账本。稳定 agent_id、状态、结果、错误、预算、worktree、hook trace、父子关系能跨 renderer 刷新保存；跨进程重启恢复按阶段推进。

## Neo 当前状态

已有能力：

- ToolSearch contract 已包含 source、mcpServer、loadable、notCallableReason、canonicalInvocation、loadedTools 等字段。
- ToolSearchService 已能把 builtin deferred tools、MCP tools、skills 纳入搜索，并支持 `select:` 精确加载和 deferred preload。
- deferred tool metadata 已覆盖 Browser、Computer、MCP、spawn_agent、agent_message、wait_agent、close_agent、workflow、workflow_orchestrate 等长任务能力。
- tool dispatch 层只暴露 core tools 和已加载 deferred schemas，prompt 中可输出 deferred summary 和 MCP name index。
- MCP client 支持 stdio、SSE/HTTP、in-process server；stdio 默认 lazy，工具列表变化后能刷新 registry 并同步 ToolSearch。
- MCP tool registry 会把 MCP annotations 映射到 read / write / execute 等权限层，并支持 Claude 风格 `mcp__server__tool` 命名。
- permissionBoundary 已覆盖 file、command、network、MCP、memory、desktop、provider key、connector、plugin、browser relay 等边界。
- childContext 已定义 strict-inherit、child-narrow、independent 三种继承模式，默认 strict-inherit；工具集合取交集、deny 取并集、权限模式取更严格值。
- SubagentExecutor 会构造 child context、注入 skills、传递 budget、hookManager、worktreePath、parentContext、spawn depth 和 parent liveness。
- SpawnGuard 管理并发、深度、agent 状态、取消、后代回收和状态持久化；但重启后 running agent 会转为 failed。
- spawnAgent 对 coder 默认 worktree isolation，explorer / reviewer / planner / awaiter 默认无隔离。
- agentWorktree 能创建临时 worktree、捕获 patch、无变更自动清理、有变更保留。
- hooks 已覆盖工具、用户输入、停止、子 agent、权限、session、compact、workflow 相邻事件，并支持 decision / observer。
- workflow launch approval 已按成本、网络、上下文泄露、后台占用四个维度做启动前审批。
- dynamic workflow runtime 已有 agent / parallel / pipeline / phase / log primitives、预算、并发门、worker sandbox、run 记录和 result cache。

主要缺口：

- ToolSearch 仍偏名字检索和 metadata 打分，没有成为能力目录。权限、hook、lazy 状态、schema 状态、agent 适配、workflow 适配分散在多个模块。
- lazy-load 命中和失败对父线程不透明。当前能按关键词发现 lazy stdio server，但没有形成稳定的 search explanation 和用户可读状态。
- 子 agent 失败结果来源较多，产品层缺少统一枚举和统一渲染合同。
- Agent Tree 还没有成为统一查询 API。SpawnGuard、ParallelAgentCoordinator、SubagentContextStore、hook history、worktree 信息各自存在。
- worktree 目前完成了隔离和安全网，但父线程的 review / discard / merge 决策还不是一等流程。
- hooks 能执行、能阻断、能修改上下文，但用户侧缺少“本次动作被哪个 hook 影响”的可见链路。
- durable background subagent 仍是短板。BackgroundSubagentRegistry 是进程内 registry，SpawnGuard 虽能持久化状态，但不恢复 running 任务。

## 长期路线

### P0：控制面成型

1. Capability Matrix manifest
   - 新增统一 capability record，覆盖 tools、MCP tools、skills、agent roles、workflow primitives。
   - 字段至少包括 `id`、`kind`、`source`、`canonicalName`、`loadState`、`schemaState`、`permissionLevel`、`permissionBoundaries`、`mcpServer`、`hookEvents`、`agentCompatibility`、`workflowCompatibility`、`worktreePolicy`、`failureCodes`、`observabilityRefs`。
   - 数据来源先从现有 ToolSearchService、deferredTools、mcpToolRegistry、agentDefinition、workflow runtime 拼装，不要求一次性重构底层。
   - 暴露只读 API，供 renderer、debug 面板、父线程 prompt summary 使用。

2. ToolSearch 能力解释
   - 在 ToolSearchResult 中增加 explanation 数据，说明匹配字段、命中 tags / aliases / searchHint、是否来自 lazy MCP discovery、是否已加载 schema。
   - 对不可调用项给出稳定原因：`schema-not-loaded`、`mcp-server-lazy`、`mcp-server-error`、`permission-required`、`skill-only`、`workbench-scope-blocked`。
   - prompt summary 保留简洁，但父线程 debug / UI 能展开完整解释。

3. lazy-load 状态
   - 把 `discoverLazyServersForSearch()` 的命中、启动、失败、注册工具数量写入 capability record。
   - MCP server state 增加最近一次 discovery reason、last error、last refreshed at、registered tool count。
   - ToolSearch 搜索 MCP 相关 query 时返回“已发现但未启动”“启动中”“启动失败”“已注册可调用”的明确状态。

4. 子 agent 失败语义
   - 定义统一 `AgentFailureCode`：`blocked-by-parent-role`、`permission-denied`、`tool-unavailable`、`budget-exhausted`、`timeout`、`parent-gone`、`cancelled-by-user`、`cancelled-by-parent`、`dependency-failed`、`dependency-missing`、`workflow-stage-failed`、`worktree-create-failed`、`model-error`、`unknown`。
   - spawn、parallel、workflow、background registry 都映射到这一组 code。
   - 父线程输出不再只展示原始 error string，要给 code、owner、recoverability、recommended next action。

5. Agent Tree 状态 API
   - 新增聚合查询，把 SpawnGuard snapshot、ParallelAgentCoordinator task state、SubagentContextStore snapshot、hook trigger history、worktree path、budget/cost 汇成一棵树。
   - 每个节点包含 status、role、mode、parentId、children、lastEvent、activeTool、failureCode、worktreeState、permissionSummary、budgetSummary。
   - renderer 和父线程都使用同一份 contract，避免 UI 和 prompt 分别拼状态。

6. worktree 产物闭环
   - 当 coder child 保留 worktree 时，Agent Tree 节点展示 worktree path、branch、patch path、dirty summary、测试摘要。
   - 提供只读 review 动作：查看 diff、查看 patch、查看 changed files、生成父线程 handoff。
   - P0 不自动 merge，只做可审查闭环。

7. hook 可观测
   - hookManager 触发记录挂到 tool call / agent node / workflow run。
   - 记录 event name、matcher、hook type、decision / observer、blocked / modified / allowed、duration、redacted output。
   - PermissionRequest、PermissionDenied、StopFailure、SubagentStop 进入 Agent Tree 时间线。

8. 权限继承审计
   - 新增 PermissionEnvelope 聚合父线程权限、childContext、subagentPipeline、MCP annotation、workflow stage toolPolicy。
   - 每次工具执行能解释最终权限来自哪里：父级允许、子级收窄、deny 命中、MCP annotation、hook decision。
   - 先覆盖 subagent 和 MCP tool，后续扩展到 desktop/browser/plugin。

### P1：后台与恢复能力

1. durable subagent ledger
   - 用持久化 ledger 替代或包住 BackgroundSubagentRegistry 的进程内状态。
   - 保存 stable agent_id、parentId、sessionId、role、prompt digest、status、failureCode、result summary、worktree path、budget、cost、startedAt、updatedAt、completedAt。
   - renderer 刷新、父线程重新打开、普通 app 生命周期内能继续查询后台任务。

2. SpawnGuard durable semantics
   - 区分 `interrupted-by-restart`、`restorable-waiting-result`、`completed-before-restart`。
   - 对无法恢复的 running task 给明确 failureCode，不伪装成普通 failed。
   - 与 Agent Tree API 共享同一个状态解释。

3. workflow run 与 subagent ledger 打通
   - dynamic workflow 每次 agent / parallel / pipeline primitive 都创建 ledger node。
   - workflow result cache 与 Agent Tree node 建关联，父线程能从 workflow run 下钻到具体子 agent。

4. ToolSearch 语义索引
   - 在现有 keyword scoring 外增加轻量 BM25 或 embedding 索引，覆盖 description、schema title、schema property、searchHint、MCP server metadata。
   - MCP listChanged、server refresh、deferred metadata 变更时做索引失效。

5. policy-as-code
   - 允许 repo 声明 MCP server、tool allow / deny、agent role、workflow stage policy、hook policy。
   - 提供 dry-run 校验：哪些工具会被禁用、哪些子 agent 会被收窄、哪些 hook 会影响写操作。

### P2：长期任务平台化

1. Agent Team product layer
   - Agent Tree 成为长任务默认入口，支持 pause、cancel、retry failed node、clone node、resume from result cache。
   - 父线程可以按角色、工具、权限、worktree、failureCode 过滤节点。

2. worktree merge queue
   - coder child 的产物进入 merge queue，记录 owner、diff summary、test evidence、conflict preview、patch safety net。
   - 合并仍需用户或父线程显式决策，默认不自动落主工作树。

3. cross-agent evidence protocol
   - 子 agent 输出 finding、decision、risk、patch、testResult、openQuestion 等结构化字段。
   - ParallelCoordinator 不再主要从自由文本解析 STATUS / DECISION。

4. hook policy UI
   - 给 hooks 增加可读策略视图，按事件、matcher、工具、agent role 展示。
   - 用户能定位“为什么这次工具调用被阻断或改写”。

5. MCP server health center
   - 展示每个 MCP server 的 scope、transport、lazy 状态、tools/resources/prompts 数量、最近 listChanged、最近错误、权限摘要。
   - 支持只读诊断，不在这个阶段做自动修复。

### Later：跨重启与跨会话恢复

1. durable execution resume
   - 对 workflow runtime 先做真正可恢复执行，因为它已有 run journal、source replay 和 result cache。
   - 对普通 LLM 子 agent，只承诺恢复状态、结果和可重试上下文，不承诺恢复中断中的模型流。

2. distributed tool platform
   - 远端 MCP、云端 worker、桌面 worker 使用同一 capability contract。
   - 权限和 hook 决策仍以本地父线程策略为准。

3. organization-level policies
   - 支持团队级 tool policy、MCP allowlist、hook baseline、agent role baseline。
   - 与个人和项目配置做明确优先级合并。

## 关键实现区域

- `src/shared/contract/toolSearch.ts`
- `src/main/services/toolSearch/toolSearchService.ts`
- `src/main/services/toolSearch/deferredTools.ts`
- `src/main/agent/runtime/contextAssembly/deferredToolPreload.ts`
- `src/main/tools/dispatch/toolDefinitions.ts`
- `src/main/tools/dispatch/toolResolver.ts`
- `src/main/mcp/mcpClient.ts`
- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/mcp/mcpDefaultServers.ts`
- `src/main/mcp/mcpConfigFile.ts`
- `src/main/mcp/types.ts`
- `src/shared/contract/permissionBoundary.ts`
- `src/main/agent/childContext.ts`
- `src/main/agent/subagentPipeline.ts`
- `src/main/agent/subagentExecutor.ts`
- `src/main/agent/subagentExecutorTypes.ts`
- `src/main/agent/backgroundSubagentRegistry.ts`
- `src/main/agent/orphanLiveness.ts`
- `src/main/agent/spawnGuard.ts`
- `src/main/agent/parallelAgentCoordinator.ts`
- `src/main/agent/multiagentTools/spawnAgent.ts`
- `src/main/agent/multiagentTools/workflowOrchestrate.ts`
- `src/main/agent/scriptRuntime/runService.ts`
- `src/main/agent/scriptRuntime/primitives.ts`
- `src/main/agent/scriptRuntime/agentBridge.ts`
- `src/main/agent/scriptRuntime/concurrencyGate.ts`
- `src/main/agent/scriptRuntime/budget.ts`
- `src/main/agent/workflowLaunchApproval.ts`
- `src/main/agent/agentWorktree.ts`
- `src/main/protocol/events/hookTypes.ts`
- `src/main/hooks/hookManager.ts`
- `src/main/hooks/hookExecutionEngine.ts`
- `src/main/hooks/configParser.ts`
- `src/main/hooks/scriptExecutor.ts`
- `src/shared/contract/agent.ts`
- `src/shared/contract/agentTypes.ts`
- `src/shared/contract/agentRegistry.ts`
- `src/shared/contract/agentSkill.ts`
- `src/shared/contract/workflow.ts`
- `src/shared/contract/workflowTemplates.ts`
- `tests/unit/tools/toolDefinitions.deferredSummary.test.ts`
- `tests/unit/mcp/mcpToolRegistry.test.ts`
- `tests/integration/mcp/listChanged.test.ts`
- `tests/unit/tools/toolExecutor.mcpDirect.test.ts`
- `tests/agent/permissionInheritance.test.ts`
- `tests/integration/permission-inheritance/scenarios.test.ts`
- `tests/unit/agent/subagentExecutor.failureCodes.test.ts`
- `tests/unit/agent/parallelAgentCoordinator.test.ts`
- `tests/unit/agent/spawnGuard.test.ts`
- `tests/unit/agent/agentWorktree.test.ts`
- `tests/unit/agent/backgroundSubagentRegistry.test.ts`
- `tests/unit/agent/scriptRuntime/runServiceResume.test.ts`
- `tests/unit/agent/workflowLaunchApproval.test.ts`
- `tests/unit/agent/toolExecutionEngine.hooks.test.ts`
- `tests/unit/agent/messageProcessor.stopHook.test.ts`

## 验收标准

P0 验收：

- Capability Matrix API 能返回 builtin deferred tool、MCP tool、skill、agent role、workflow primitive 五类记录。
- 每条 capability record 至少包含 load state、schema state、permission level、permission boundary、source、canonical name 和 observability refs。
- ToolSearch 对 MCP / workflow / browser / computer / subagent 类 query 返回 explanation，能说明命中原因和不可调用原因。
- lazy MCP server 在搜索命中、启动成功、启动失败、注册工具变化时都有可读状态。
- spawn、parallel、workflow 的失败结果都映射到统一 AgentFailureCode。
- Agent Tree API 能展示父子关系、状态、失败原因、预算摘要、hook 事件和 worktree 信息。
- coder 子 agent 产生保留 worktree 时，父线程能看到 diff / patch / changed files / worktree path。
- PreToolUse、PostToolUse、SubagentStart、SubagentStop、PermissionRequest、PermissionDenied 至少进入一次端到端时间线测试。
- 权限继承审计能解释一个 MCP tool 在子 agent 内被允许或拒绝的原因。

P1 验收：

- background subagent ledger 能跨 renderer 刷新查询 stable agent_id、状态、结果和错误。
- app 重启后，running agent 不再只表现为普通 failed，而是有明确 interrupted 状态和可重试信息。
- workflow run 中的 agent primitive 能出现在 Agent Tree 里。
- ToolSearch 语义索引覆盖 schema property 和 searchHint，MCP listChanged 后索引能失效并重建。
- repo policy dry-run 能报告 tool allow / deny、agent role 收窄、hook 影响。

P2 验收：

- Agent Tree 支持 retry failed node、cancel subtree、查看 worktree artifact、查看 hook timeline。
- worktree merge queue 能列出每个 coder child 的 diff summary、test evidence、patch safety net。
- 子 agent 可以输出结构化 finding / decision / risk / testResult，并被 ParallelCoordinator 聚合。
- MCP server health center 能展示 transport、scope、lazy 状态、tool count、最近错误。

## 风险与未决问题

- Capability Matrix 容易变成又一份重复 registry。实现时要先聚合现有数据源，避免重写 ToolSearch、MCP registry、agent registry。
- ToolSearch explanation 会增加 prompt 和 UI 信息量。默认 prompt 仍应简洁，完整解释只在 debug、UI、父线程按需展开。
- lazy-load 的语义要谨慎。搜索命中不等于用户授权，也不等于 server 可安全启动。
- 权限继承审计需要避免泄露敏感配置和 hook 输出。审计记录应保留 redaction 规则。
- durable subagent ledger 不能承诺恢复中断中的模型调用。第一阶段只承诺状态、结果、错误和可重试上下文。
- worktree merge queue 涉及用户未审代码，默认只读 review，不自动 merge。
- dynamic workflow 仍有 sandbox 风险。长期平台化前，需要继续压实 worker 隔离和脚本能力边界。
- hook decision 和 permission decision 的优先级需要产品化说明，否则用户会困惑为什么某次操作被拒。
- Agent Tree 聚合多个状态源，必须定义 owner of truth。建议 SpawnGuard 管 agent lifecycle，ledger 管持久记录，Capability Matrix 管能力定义，hook history 管策略事件。

## 证据来源

本仓证据：

- `src/shared/contract/toolSearch.ts`
- `src/main/services/toolSearch/toolSearchService.ts`
- `src/main/services/toolSearch/deferredTools.ts`
- `src/main/agent/runtime/contextAssembly/deferredToolPreload.ts`
- `src/main/tools/dispatch/toolDefinitions.ts`
- `src/main/tools/dispatch/toolResolver.ts`
- `src/main/mcp/mcpClient.ts`
- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/mcp/mcpDefaultServers.ts`
- `src/main/mcp/mcpConfigFile.ts`
- `src/main/mcp/types.ts`
- `src/shared/contract/permissionBoundary.ts`
- `src/main/agent/childContext.ts`
- `src/main/agent/subagentPipeline.ts`
- `src/main/agent/subagentExecutor.ts`
- `src/main/agent/backgroundSubagentRegistry.ts`
- `src/main/agent/orphanLiveness.ts`
- `src/main/agent/spawnGuard.ts`
- `src/main/agent/parallelAgentCoordinator.ts`
- `src/main/agent/multiagentTools/spawnAgent.ts`
- `src/main/agent/multiagentTools/workflowOrchestrate.ts`
- `src/main/agent/scriptRuntime/runService.ts`
- `src/main/agent/workflowLaunchApproval.ts`
- `src/main/agent/agentWorktree.ts`
- `src/main/protocol/events/hookTypes.ts`
- `src/main/hooks/hookManager.ts`
- `docs/decisions/006-deferred-tools-consolidation.md`
- `docs/decisions/025-subagent-background-execution-and-resume.md`
- `docs/architecture/multiagent-system.md`
- `docs/plans/parallel-agent-execution-guide.md`

外部官方方向来自本线程已收口 brief：

- Claude Code：MCP、hooks、subagents、settings permissions、git worktree workflow。
- Cursor：Agent、Rules、MCP、Background Agents。
- GitHub Copilot coding agent：issue / PR / GitHub Actions 驱动的 cloud agent 工作流。
- OpenAI Codex：sandbox、approval、AGENTS.md、MCP、本地和云端任务执行。
- OpenCode：provider-agnostic agent、MCP、permissions、agent config。
