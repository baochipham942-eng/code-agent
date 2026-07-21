# 工具系统架构

> ToolRegistry + ToolExecutor + Core/Deferred 双层 + 统一工具合并

## 2026-07-11 Run-scoped 工具安全合同

| 能力 | 当前合同 | 关键文件 / 测试 |
|------|----------|----------------|
| cache admission | 显式准入、默认 fail-closed；当前策略表为空，Read 也不缓存，避免跳过 file-read evidence 和 context-health 副作用 | `services/infra/toolCache.ts`、`toolCache.security.test.ts` |
| cache identity | `tool-cache:v3` 完整键包含 tool/policy version、normalized args、workspace realpath fingerprint、session、server identity、capability policy version、data fingerprint 或 TTL bucket；canonical workspace 不可得时不读不写 | `toolCache.ts`、[MCP Durable Task 与安全 ToolCache](./mcp-durable-task-and-tool-cache.md) |
| invalidation | 文件与 workspace 变化按同一 scope 失效；旧 namespace 自然失效，不清表 | `toolExecutor.ts`、`toolExecutor.cacheSafety.test.ts` |
| execution ledger | begin 落账前递归脱敏 header/env/token/apiKey/secret/command，循环结构安全降级 | `toolExecutorHelpers.ts`、`toolExecutor.executionLedger.test.ts` |
| cache replay audit | cache hit 仍写 begin/complete execution ledger，并在活动 tool span 标记 `tool.cache_hit=true` | `toolExecutor.ts`、`toolExecutor.cacheSafety.test.ts` |
| Run isolation | 每个 Native run 使用独立 ToolExecutor，路径、shell、checkpoint、artifact 与 Bridge payload 消费冻结的 RunContext | [native-run-context.md](./native-run-context.md) |
| SSE integrity | tool name/arguments 不完整或 arguments JSON 不可解析时拒绝执行，截断只作为错误证据 | `model/providers/sseStream.ts`、`sseStream.snapshot.test.ts` |

会话权限入口同步收口为四档：`default / readOnly / acceptEdits / bypassPermissions`。显式会话选择持久化；readOnly 对读放行、写与执行确认；bypass 需用户批准；无人值守 session 的 effective mode 最高钳到 acceptEdits。所有 ToolExecutor、subagent 和 Bash sandbox 判定必须读取 session effective mode，不能直接读取进程级默认档。

## 工具定义格式

**位置**: `src/host/tools/`

```typescript
interface Tool {
  name: string;
  description: string;
  dynamicDescription?: () => string;  // 运行时生成描述（如 Skill 聚合可用 skills）
  inputSchema: JSONSchema;
  isCore?: boolean;                   // 强制标记为核心工具
  requiresPermission: boolean;
  permissionLevel: 'read' | 'write' | 'execute' | 'network';
  execute: (params, context) => Promise<ToolExecutionResult>;
}
```

## 工具执行流程

```
输入: toolCalls = [
  { id: "call_abc123", name: "Edit", arguments: {...} },
  { id: "call_def456", name: "Bash", arguments: {...} }
]

FOR EACH toolCall:
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  1. 发送开始事件                                                           │
│     onEvent({ type: 'tool_call_start', data: toolCall })                    │
│     → UI: MessageBubble 显示 "Running Edit..."                              │
│                                                                             │
│  2. 执行工具                                                               │
│     ToolExecutor.execute(name, arguments, context)                          │
│     │                                                                       │
│     ├─ 查找工具: ToolRegistry.get('Edit')                                  │
│     │  └─ 支持别名: edit_file → Edit, read_pdf → ReadDocument              │
│     │                                                                       │
│     ├─ 别名参数注入:                                                       │
│     │  └─ ALIAS_DEFAULT_PARAMS 自动注入 action 字段                        │
│     │     如 read_pdf → { action: 'read', format: 'pdf' }                  │
│     │                                                                       │
│     ├─ 权限检查 (如需要):                                                  │
│     │  ├─ autoApprove 设置? → 自动批准                                     │
│     │  └─ 否则 → onEvent({ type: 'permission_request' })                   │
│     │            等待用户响应                                               │
│     │                                                                       │
│     └─ 工具执行:                                                           │
│        tool.execute(arguments, context)                                     │
│        → ToolExecutionResult { success, output?, error? }                  │
│                                                                             │
│  3. 构建结果                                                               │
│     ToolResult {                                                            │
│       toolCallId: "call_abc123",                                           │
│       success: true,                                                        │
│       output: "Edited file: ...",                                          │
│       duration: 45                                                          │
│     }                                                                       │
│                                                                             │
│  4. 发送结束事件                                                           │
│     onEvent({ type: 'tool_call_end', data: toolResult })                    │
│     → UI: MessageBubble 通过 toolCallId 匹配并显示结果                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2026-06-18 Firecrawl default web data layer

`WebSearch` / `WebFetch` 的默认公网数据层从“只在用户配好 premium key 后才稳定”调整为“Firecrawl 优先，native/其他源兜底”。它仍然挂在既有网络工具链路上，没有新增第二套搜索工具。

| 能力 | 当前合同 | 关键文件 / 测试 |
|------|----------|----------------|
| Firecrawl default | `WebSearch` routing 默认把 `firecrawl` 放在第一优先级；`sources` 显式指定时仍按用户要求过滤 | `searchStrategies.ts`、`webSearch.ts`、`searchStrategies.firecrawl.test.ts` |
| Keyless/authenticated mode | 无 key 时用 keyless Firecrawl，结果 source 标为 `firecrawl-keyless`；有 `FIRECRAWL_API_KEY` 或 Service API key 时走 authenticated | `firecrawlClient.ts`、`firecrawlUsage.test.ts` |
| URL eligibility | 公网 HTML/PDF 等页面可走 Firecrawl scrape；localhost、私网、`.local`、`.internal` 和 raw data URL 回 native fetch | `shouldUseFirecrawlForUrl()`、`fetchDocument.firecrawl.test.ts` |
| Health cooldown | Firecrawl 连续 3 次传输/HTTP 失败后进入 60 秒冷却，冷却期搜索跳过 Firecrawl，fetch 直接走 native fallback；冷却到期自动恢复 | `recordFirecrawlOutcome()`、`firecrawlHealth.test.ts` |
| Unused source hint | Perplexity/Exa/Brave/Tavily 已配置但未被本轮 routing 命中时，成功输出后追加一行 `sources` 软提示；用户已传 `sources` 时不提示 | `buildUnusedSourcesHint()`、`unusedSourcesHint.test.ts` |
| Auto-extract fetch | `fetchDocument()` 先尝试 Firecrawl scrape 并缓存 markdown；失败后走原生 fetch，结果带 `fallbackReason` | `fetchDocument.ts`、`fetchDocument.firecrawl.test.ts` |

边界：

- Firecrawl default 可通过 `CODE_AGENT_DISABLE_FIRECRAWL_DEFAULT=1` 或 `CODE_AGENT_WEB_DATA_PRIMARY/PROVIDER=native` 关闭。
- Firecrawl 不代理本地或私网 URL；这类 URL 保持 native fetch，避免把本机/内网地址交给公网服务。
- Health cooldown 是本进程短时保护，目标是少吃超时，不是长期供应商状态库。

---

## 2026-06-17 Tool execution ledger and result recovery

这一轮把工具调用从“执行完给 UI 一个结果”推进到“执行前后都有可审计事件，失败结果有统一恢复动作”。主执行链仍是 `ToolExecutor -> ToolResolver -> handler`，新增内容都是边界层。

| 能力 | 当前合同 | 关键文件 / 测试 |
|------|----------|----------------|
| Permission decision ledger | 权限决策进入 `permission_decisions` append-only 表；`recordDecision()` 继续写内存 history，同时 best-effort 追加 durable record，数据库异常被吞掉 | `toolExecutor.ts`、`databaseService.appendPermissionDecision()`、`tests/unit/tools/toolExecutor.ledger.test.ts` |
| Tool execution events | 工具通过权限和 policy 后写 begin，handler 返回/抛错/被归一化后写 complete；`execution_id` 串起同一次调用，未闭合 begin 可作为崩溃现场 | `tool_execution_events`、`appendToolExecutionBegin/Complete()`、`tests/unit/tools/toolExecutor.executionLedger.test.ts` |
| Required-field feedback | 执行前读取真实 tool schema 的 `required` 字段，缺参数时直接返回失败结果，错误文本点名缺失字段并要求按 schema 重调 | `toolExecutor.ts` |
| Failure actions | renderer 用 `buildToolErrorActions()` 判断失败工具是否展示复制错误和“从此重试”；retry 复用现有 forkFromHere，不新增工具级 replay 协议 | `toolExecutionPresentation.ts`、`tests/renderer/components/toolErrorActions.test.ts` |
| Auto-loaded retry filtering | 工具未加载后自动加载再重试属于内部恢复状态，`metadata.autoLoaded` 这类结果不进入失败汇总和 tool loop decision | `isAutoLoadedRetry()`、`toolResultEcho.ts` |
| Bash output presentation | Bash 原始输出仍在结果中；展示层对长输出保留头尾，对流式进度帧做折叠，并把 Bash 非 0 exit code 显式渲染成不可靠状态 | `ToolCallDisplay/bashOutputPreview.ts`、`statusLabels.ts` |

边界：

- ledger 是审计面，不是执行前置条件。写账失败不能改变工具 allow/deny 或 handler 结果。
- required-field guard 只处理 schema 里的结构缺参，不替代 handler 内部业务校验。
- “从此重试”从消息处 fork 会话，让用户保留失败现场上下文；它不保证重放同一个 tool call id。

---

## 2026-05-15 In-App HTML Validation Tool

`validate_html_in_app` 把 HTML artifact 验收从外部脚本带回 Agent Neo 右侧工作面板。它是 vision 类 native ToolModule，执行时通过 main↔renderer IPC 请求 `InAppValidationPanel` 打开 sandboxed iframe，加载 HTML 后跑交互脚本和断言。

| 层 | 职责 | 文件 |
|----|------|------|
| Tool schema | 暴露 `html / htmlPath / steps / timeoutMs`；steps 支持 click、click-selector、hover、type、press、wait；expect 支持 text/selector/canvas 断言 | `src/host/tools/modules/vision/validateHtmlInApp.schema.ts` |
| Tool handler | 读取 inline HTML 或本地 HTML 文件，生成 requestId，调用 in-app validation service，返回逐步 pass/fail 汇总 | `src/host/tools/modules/vision/validateHtmlInApp.ts` |
| Shared DSL | main 的 `visualSmoke` 和 renderer 的 In-App panel 共用 `BrowserInteractionStep` / `BrowserInteractionExpect` | `src/shared/contract/browserInteraction.ts` |
| IPC / service | main 向 renderer 发验证请求，renderer 回传结果或错误 | `src/host/ipc/inAppValidation.ipc.ts`、`src/host/services/inAppValidationService.ts` |
| Renderer panel | 右侧 iframe 面板展示 HTML、步骤状态、失败原因和用户可见的验证过程 | `src/renderer/components/features/inAppValidation/InAppValidationPanel.tsx` |

当前边界：
- 面向自己生成或本地可控的 HTML artifact；公开网站会受 cross-origin、X-Frame-Options 和 `event.isTrusted=false` 限制。
- 适合 UI 状态、文本可见性、selector 和 canvas nonblank 检查；原生菜单、真实 hover 复杂样式、drag-and-drop 仍走 Playwright/CDP 或人工接管。
- `permissionLevel` 是 `execute`，Plan mode 不直接运行，避免把交互验证误当只读观察。

## 2026-04-27 工具执行与搜索加固

这轮修的是工具系统里最容易造成产品误导的几条链路：看得见但跑不了、审批结果不一致、搜索结果像工具但不可调用、Skill 配置自动扩权。

### 权限合同

`ToolExecutor` 是当前唯一的顶层审批入口。顶层审批结果会通过 `approvedToolCall` 放进 execution context，再传给 `ToolResolver` / protocol handler，避免同一 tool+args 在 native protocol path 里重复审批或绕开审批。

当前约束：

- `Bash` / `bash` 在安全校验里归一，危险命令走同一 pre-validation。
- legacy wrapper 的 `requestPermission` 不再固定放行，Browser/Computer 这类二级审批必须转发真实 permission path。
- project/user skill 的 `allowed-tools` 不自动变成 runtime preapproval；只有 builtin/plugin skill 可以进入自动扩权路径。
- MCP annotations 映射到统一 permission model，read-only / destructive / token 泄漏风险不再只靠工具名猜。

测试锚点：

- `tests/security/toolExecutor-safety.test.ts`
- `tests/unit/tools/toolExecutor.protocolApproval.test.ts`
- `tests/unit/tools/legacyAdapter.permission.test.ts`
- `tests/unit/tools/skillMetaTool.security.test.ts`

### Decision Trace 与写隔离（2026-06-01）

产品闭环阶段把“自动批准为什么发生”和“多个写动作会不会互相踩”收进工具执行层。

| 能力 | 当前合同 | 关键文件 / 测试 |
|------|----------|----------------|
| `DecisionTrace` | 自动 permission decision 必须能回放 classifier、reason、risk 和结果；artifact/eval 质量问题也可引用同一 trace | `src/host/security/decisionHistory.ts`、`src/shared/contract/productClosure.ts`、`tests/unit/tools/toolExecutor.decisionTrace.test.ts` |
| workspace/file write isolation | `Bash` / execute 视为 workspace 写锁；`Write` / `Edit` / `Append` / `MultiEdit` 按目标文件判断冲突；无文件参数时退到 workspace 锁 | `src/host/security/writeIsolation.ts`、`tests/unit/tools/toolExecutor.writeIsolation.test.ts` |
| dynamic workflow write gate | workflow run 内 edit/full agent 先过 `SerialWriteGate` 串行，普通工具执行再过 ToolExecutor 写隔离 | `src/host/agent/scriptRuntime/writeGate.ts`、`tests/unit/agent/scriptRuntime/agentBridge.test.ts` |
| hook 日志脱敏（GAP-015，PR #196）| hook 执行的观测日志（UI 可见的 hookManager trigger history + async hook 失败日志）接 `maskSensitiveData` 脱敏，复用 auditLogger 同款掩码，避免密钥经 hook 日志泄漏 | `src/host/hooks/hookExecutionEngine.ts`、`src/host/hooks/hookManager.ts`、`tests/unit/hooks/hookSanitizationAndTrace.test.ts` |

这层是进程内串行和冲突判断，不等于 per-agent git worktree。真正需要并行写入同一个 repo 时，仍要在上层分配独立工作树或做更细的文件锁策略。

### Skill allowed-tools 限权边界（GAP-001，PR #192）

`allowed-tools` 从"仅预审批扩权"升级为"限权边界"。此前 project/user skill 的 `allowed-tools` 只对 builtin/plugin skill 起自动扩权作用，列表外的工具仍可被无审批调用——一个"只读" skill 若上下文里有 `Bash` 仍能写文件。现在 `allowed-tools` 对**所有来源**的 skill 都构成工具边界：

- 边界外工具调用强制走用户审批（rule: `skill.allowed-tools-boundary`），通过 `runtimeContext.skillToolBoundary` 传递；
- 仅 builtin/plugin skill 的**边界内**工具可继续免审批；只读工具不受门控；
- fork 模式语义不变（已通过 subagent `availableTools` 天然受限）。

关键文件：`src/host/tools/modules/skill/skill.ts`、`src/host/tools/toolExecutor.ts`、`src/host/services/skills/skillInvocationResolver.ts`、`src/shared/contract/agentSkill.ts`。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

`strictToolset` 是比 GAP-001 软边界更硬的收缩（把模型可见工具直接砍到 allowedTools，边界外工具不可见而非待审批），仅 create-role/edit-role 等 opt-in skill 使用。硬收缩激活时 `buildStrictToolsetNotice()`（`skillBoundaryScope.ts`）向模型注入原因和退出方式，配套的 `exit_role_flow` 工具让模型显式退出、恢复全量工具集。详见 [agent-core.md 的跨轮 sticky 恢复与退出](agent-core.md#跨轮-sticky-恢复与退出2026-07-21pr-532)。

### PolicyEnforcer 接线（GAP-002，PR #192）

`PolicyEnforcer` 此前整层是 dead code（完整实现但从未被调用），`policy.toml` 的 `denied_path` 等规则形同虚设。现在它接进 `ToolExecutor.execute()`——在 guard_fabric 之后、任何审批路径（skill 预审批 / 安全白名单 / classifier）之前执行 policy 检查，规则真实生效，`DecisionTrace` 里随之出现 `policy_enforcer` 层。无 policy 文件时不再每次调用都重新探测文件系统。

关键文件：`src/host/security/policyEnforcer.ts`、`src/host/agent/runtime/toolExecutionEngine.ts`。开关：`policy.toml` 存在即生效。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

### MCP dynamic direct execute

MCP tool 的模型可见名称仍沿用 Claude Code 风格：`mcp__<server>__<tool>`。2026-04-27 之后，`ToolResolver` 能识别这类 dynamic tool，并把调用落到 `MCPClient.callTool(serverName, toolName, args)`，不再停在 ToolSearch 可见、execute unknown 的半截状态。

```
ToolSearch("github search")
  -> mcp__github__search_code loaded
  -> ToolExecutor.execute("mcp__github__search_code", args)
  -> ToolResolver.parseMCPToolName()
  -> MCPClient.callTool("github", "search_code", args)
```

关键文件：

- `src/host/mcp/mcpToolRegistry.ts`
- `src/host/mcp/mcpClient.ts`
- `src/host/tools/dispatch/toolResolver.ts`
- `tests/unit/protocol/toolResolver.mcpDirect.test.ts`
- `tests/unit/tools/toolExecutor.mcpDirect.test.ts`

### 2026-06-12 MCP self-service and HTTP Streamable setup

MCP 管理从"管理员代配"调整为"普通登录用户可自助管理 server"，但低层运行诊断仍保留 admin 边界：

| 能力 | 当前合同 | 关键文件 |
|------|----------|----------|
| 自助管理 | Settings 里的已连接/发现页允许普通用户添加、启停、重连、从云端刷新 MCP server；LocalBridge / Native connector 运行状态只对 admin 展示 | `MCPSettings.tsx`、`McpDiscoverTab.tsx` |
| HTTP Streamable | `mcp_add_server` 与 `MCPUnified({ action:"add_server" })` 接受 `http-streamable` 和兼容别名 `http`，持久化为 `type:"http-streamable"` | `mcpAddServer.ts`、`mcpAddServer.schema.ts`、`mcpUnified.schema.ts` |
| Settings JSON 兼容 | 远端 server 可传 `serverUrl` 或 `url`，可带 headers；SSE 仍作为 legacy remote type 保留，stdio 继续走本地命令校验 | 同上 |
| Intent preload | 用户明确说配置/添加/连接/管理 MCP 时，本轮预加载 `MCPUnified`，减少模型看不见管理工具而绕路的概率 | `deferredToolPreload.ts` |

这层只改变用户能否管理自己的 MCP 配置，不改变 MCP dynamic direct execute 的权限模型：具体 MCP tool 调用仍走 `ToolExecutor` / resolver / MCP client 统一执行链。

### MCP 工具名索引（GAP-008，PR #194）

MCP 工具不再把全量 schema 注入每轮请求。deferred-tools summary 只注入名字索引（`mcp__<server>__<tool>` 格式），完整 schema 通过 `ToolSearch` 按需加载，再走上面的 dynamic direct execute 链路调用。这样模型既能"看见"所有 MCP 工具的存在并主动检索，又不会被大量 MCP schema 撑爆上下文。

关键文件：`src/host/mcp/mcpToolRegistry.ts`、`src/host/tools/dispatch/toolDefinitions.ts`、`src/host/services/toolSearch/toolSearchService.ts`。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

### ToolSearch loadable 语义

`ToolSearchService` 的结果现在区分“搜索命中”和“下一轮可调用”。

| 字段 | 含义 |
|------|------|
| `loadable: true` | 结果会进入 loaded deferred tools，模型下一轮能用 `canonicalInvocation` 调用 |
| `loadable: false` | 只是概念/文档/Skill search 命中，不会伪装成可调用工具 |
| `notCallableReason` | 给模型和 UI 的原因，比如没有注册 protocol tool、Skill 需要走 `Skill(command=...)` |
| `canonicalInvocation` | 可调用时给出真实工具名；不可调用时保持空或给出替代调用建议 |

lazy stdio MCP server 不会在启动时全量拉起；ToolSearch 遇到相关 query 时，会只 discover 匹配的 lazy server，并把 server-level discovery success/error 写回结果 metadata。这样能发现 `sequential-thinking` 这类启用但未连接的 server，又不会把所有 lazy stdio 进程都启动。

测试锚点：

- `tests/unit/services/toolSearchService.test.ts`
- `tests/unit/mcp/mcpToolRegistry.test.ts`

### Semantic tool metadata

工具调用可以带 `_meta.shortDescription / targetContext / expectedOutcome`。Provider shared schema 会把 `_meta` 注入每个 tool 的 `inputSchema.properties`，parser 抽出后写到 `ToolCall` 顶层，并从真实 arguments 中删除，避免污染工具执行参数。模型漏填时，fallback generator 会补 `shortDescription`，保证 UI 不再退回裸工具名。

对应展示路径见 [workbench.md](./workbench.md#46-semantic-tool-ui)。

### 出站 MCP：只读任务状态 server（P3-A，2026-06-04）

上面的 MCP 链路是 **入站**（Neo 作为 client 消费外部 MCP server 的工具）。P3-A 是 **出站**——Neo 自己起一个只读 MCP server，把任务/项目状态暴露给外部编排器（Coze / codeg 等）。它不进 native ToolModule registry，走独立 `src/host/mcp/mcpServer.ts` + `logBridge.ts`，与现有 `get_logs`/`get_status`/`screenshot` 等只读工具同源。

- 新增三只读工具 `neo_list_tasks` / `neo_get_task_status` / `neo_list_projects`，只出状态枚举/进度计数/token-cost/`filesChangedCount`（计数不出路径），`includeContent` 默认 false。
- 数据经 `TaskStatusProvider`（`src/host/mcp/taskStatusProvider.ts`）桥接，app 进程启动注册；web 路径（发行版）与 main 路径双注册幂等。
- 完整工具清单与隐私边界见 [MCP_SERVER.md](../MCP_SERVER.md#41-只读任务项目状态p3-a2026-06-04)。延续 WS5 不变量：只读、绝不暴露控屏/写入/正文。

---

## 2026-05 Native ToolModule 迁移

工具系统从 legacy wrapper 逐步迁到 `ToolModule` 原生协议形态。新路径不是单纯改文件名，它把 schema、handler loader、registry resolve 和权限上下文放到同一套 contract 下，减少 wrapper 转译层造成的审批、abort、参数校验漂移。

### 当前入口

| 层 | 文件 | 职责 |
|----|------|------|
| 协议类型 | `src/host/protocol/tools.ts` | `ToolSchema / ToolHandler / ToolRegistry` 的基础 contract |
| Registry | `src/host/tools/registry.ts` | 注册 schema、懒加载 handler、合并并发 resolve、按 readOnly/category/deny 过滤 |
| Modules index | `src/host/tools/modules/index.ts` | eager import schema，lazy import tool module 实现，统一注册迁移后的工具 |
| Executor | `src/host/tools/toolExecutor.ts` | 顶层审批、hook、abort signal、执行结果归一 |
| Resolver | `src/host/tools/dispatch/toolResolver.ts` | 统一解析 legacy alias、native module、MCP dynamic tool |

### Wave 覆盖面

| Wave | 覆盖工具域 | 文档口径 |
|------|------------|----------|
| Wave 1 | Search / Skill / LSP | search、skillCreate、lsp、diagnostics 进入 native module；LSP 生产化见下节 |
| Wave 2 | Document / Excel / MCP | docEdit/docxEdit、ExcelAutomate、mcpInvoke/mcpAddServer/mcpUnified 迁移；旧 `tools/mcp/` legacy path 删除 |
| Wave 3 | Multiagent / Planning | spawn/wait/close/send_input、workflow、plan/task/findings/confirm action 迁移；保持 IPC schema 兼容 |
| Wave 4 | Vision / Network / Media / Docgen / PPT | Browser、Computer、screenshot、gui_agent、image/video/speech/pdf/ppt/docx/excel 等进入 native module |

迁移完成的工具用 `.schema.ts` 提供单一 schema source，并在 `modules/index.ts` 中注册。旧 wrapper 只作为兼容层存在，不能再承载新的业务语义。

### 用户可见的可靠性变化

| 能力 | 行为 |
|------|------|
| WebFetch URL 强约束 | `WebFetch` / `web_fetch` 不再接受无 URL 的抓取调用；模型需要先搜索再带 URL 抓取 |
| ToolSearch failure | 没有 callable 工具命中时返回明确失败，不伪装成已加载能力 |
| Edit anchor hint | `old_text` 不匹配时返回最近锚点行，下一轮可以按真实上下文改准 |
| Abort chain | native handler 通过同一 `ToolContext.signal` 感知 run-level cancel |
| Permission chain | 顶层审批结果通过 `approvedToolCall` 贯通，不在 native path 里重复审批或绕开审批 |

### LSP 生产化

LSP 不再只是“有 diagnostics 工具”。当前实现把语言识别、server 安装、错误提示和 native 工具执行串在一起：

| 能力 | 文件 | 说明 |
|------|------|------|
| 语言映射 | `src/host/lsp/languages.ts` | 后缀映射扩到 100+，覆盖常见前后端、脚本、配置和文档语言 |
| 自动安装 | `src/host/lsp/installer.ts` | npm 类 language server 可自动安装；安装失败不吞掉，返回可执行的 `installCmd` |
| 生命周期管理 | `src/host/lsp/manager.ts` | server 启动、复用、诊断请求和失败归因 |
| ToolModule | `src/host/tools/modules/lsp/lsp.ts`、`diagnostics.ts` | LSP 与 diagnostics 走 native schema / handler |

用户侧结果要表达“这个语言服务不可用以及怎么装”，不要只返回 generic tool error。

### Computer-use MCP 入口归位（2026-05-13）

`feature/mcp-computer-use` 把 Computer + Screenshot 包装成独立 native ToolModule，统一走 MCP 工具入口。这是 Level 1 wrapper-mode 的运行时入口归位，不改变用户可见的 Computer 工具语义。

| 能力 | 文件 | 说明 |
|------|------|------|
| Computer ToolModule | `src/host/tools/modules/vision/computer.ts`、`computer.schema.ts` | `ComputerHandler` 做权限检查（`canUseTool`）后委托 legacy `ComputerTool.execute`，结果经 `adaptVisionLegacyResult` 适配回 native 形态 |
| 当前边界 | — | 执行内核仍委托 legacy 实现，Level 2 原生重写后再替换为直连截图 / computer surface；computer-use 工作台诊断（失败原因 / 权限拒绝 / 目标应用状态）见 [workbench.md](./workbench.md) |

### Shell command policy

5/10 后，旧 Codex sandbox / cross-verify 路径退场，shell 统一走 `src/host/tools/modules/shell/commandPolicy.ts`。它负责把命令风险、审批范围、bash policy 和 UI 展示放到同一个决策面，避免 hybrid agent 分支里再维护第二套 shell 解释。

### Bash 前台命令的后台子进程逃生（2026-05-28）

**问题**（commit `f6d0f031` 实证）：前台 `runForegroundCommand` 只在子进程 `'close'`（stdio 管道 EOF）才 settle。命令里被 `&` 后台化的子/孙进程（如 `python3 -m http.server 8099 &`）会**继承并持有 stdout 管道写端**，EOF 永不到达 → `'close'` 永不触发 → 工具 Promise 永不 settle → 整个 agent run 挂死到超时。

而 `&` 在命令**中间**（非结尾）不会被 `rewriteImplicitBackgroundCommand` 当成后台命令，会落到前台路径触发上述问题。旧 timeout 的 `child.kill('SIGTERM')` 只能打到直接子进程（shell，常已退），孤儿后台进程收不到信号。

**修复**：

| 维度 | 改动 | 常量 |
|------|------|------|
| **D1 settle 路径** | 新增 `'exit'` 事件 + 短窗口兜底——shell 退出后给极短窗口让正常 `'close'` 优先，超时则用 exit 结果 settle，不再死等管道 EOF | `POST_EXIT_DRAIN_MS = 150ms` |
| **D2 进程组回收** | `spawn` 时加 `detached:true`（独立进程组）；`killChild` 用 `process.kill(-pid)` 整组 kill；SIGTERM 宽限后升级 SIGKILL | `KILL_GRACE_MS = 2s` |
| **正常命令** | 仍走 `'close'`，行为不变 | — |
| **正常退出尊重 `&`** | 不杀被后台化的进程 | — |

**验证**：
- TDD：`bash.test.ts` 加 D1（前台起后台子进程须立即返回）/ D2（超时须整组回收）两个真实 spawn 用例，先 RED 后 GREEN
- E2E：webServer 真实运行时让 MiMo 跑 `python3 -m http.server 8099 & echo started` → Bash 168ms 返回 `"started"`、run agent_complete 46s 收尾（旧代码挂到超时）

---

## Core / Deferred 双层架构

工具分为 **核心工具**（始终发送给模型）和 **延迟工具**（按需通过 ToolSearch 发现加载）。

**位置**: `src/host/tools/registry.ts` + `src/host/tools/modules/index.ts`

### 核心工具（CORE_TOOLS）

始终包含在每次模型请求中，共 15 个：

| 工具 | 功能 |
|------|------|
| `Bash` | 执行 shell 命令 |
| `Read` | 读取文件内容 |
| `Write` | 创建/覆盖文件 |
| `Edit` | 精确编辑文件（old_string/new_string） |
| `Glob` | 文件模式匹配 |
| `Grep` | 内容搜索 |
| `ListDirectory` | 列出目录 |
| `TaskManager` | 任务管理 CRUD |
| `AskUserQuestion` | 用户交互 |
| `WebSearch` | 网络搜索 |
| `MemoryWrite` | 写入长期记忆 |
| `MemoryRead` | 读取长期记忆 |
| `ToolSearch` | 搜索和加载延迟工具 |
| `Skill` | 技能元工具（动态描述聚合可用 skills） |

### 延迟工具（schema-backed ToolModule）

不随每次请求发送，模型需要时通过 `ToolSearch` 按名称/关键词/别名搜索加载。2026-05 之后，延迟工具以 `.schema.ts` + lazy implementation 的 `ToolModule` 形态注册到 `src/host/tools/modules/index.ts`，`ToolRegistry.resolve(name)` 首次调用时才加载 handler。

---

## 工具分类总览（108 个 native ToolModule）

当前 registry 注册 108 个 native ToolModule，schema 文件 108 个。数量是运行时口径，文档长期只维护分类和代表能力。

| 分类 | 代表工具 |
|------|----------|
| Shell & 文件 | Bash, Read, Write, Edit, MultiEdit, Glob, Grep, GitCommit, NotebookEdit |
| 规划 & 任务 | TaskManager, Plan, PlanMode, AskUserQuestion, Task, confirm_action, findings_write |
| Web & 搜索 | WebSearch, WebFetch, ReadDocument, LSP, Diagnostics |
| 文档 & 媒体 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart/QRCode, Speech |
| 外部服务连接器 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | Computer, Browser, Screenshot, GuiAgent, visual_edit |
| 多 Agent | AgentSpawn, AgentMessage, WaitAgent, CloseAgent, SendInput, Teammate |
| 统一入口 / 元工具 | Process, MCPUnified, DocEdit, ExcelAutomate, PdfAutomate, ToolSearch |

---

## Deferred Tools Consolidation（Phase 2）

### 设计动机

31 个独立延迟工具合并为 9 个统一工具，通过 `action` 参数分发。减少模型需要记忆的工具名数量，同时保持向后兼容。

### 9 个统一工具

| 统一工具 | 合并来源 | action 参数 |
|----------|----------|-------------|
| `Process` | process_list/poll/log/write/submit/kill, kill_shell, task_output | list, poll, log, write, submit, kill |
| `MCPUnified` | mcp_list_tools/list_resources/read_resource/get_status/add_server | list_tools, list_resources, read_resource, get_status, add_server |
| `TaskManager` | task_create/get/list/update | create, get, list, update |
| `Plan` | plan_read, plan_update, plan_recover_recent_work | read, update, recover_recent_work |
| `PlanMode` | enter_plan_mode, exit_plan_mode | enter, exit |
| `WebFetch` | web_fetch, http_request | fetch, http |
| `ReadDocument` | read_pdf, read_docx, read_xlsx | read (+ format 参数) |
| `Browser` | browser_navigate, browser_action | navigate, action |
| `Computer` | screenshot, computer_use | screenshot, use |

### 别名兼容机制

旧工具名通过 `TOOL_ALIASES` 映射到新统一工具，`ALIAS_DEFAULT_PARAMS` 自动注入对应的 `action` 参数：

```typescript
// 别名映射
TOOL_ALIASES: { read_pdf: 'ReadDocument', browser_navigate: 'Browser', ... }

// 自动注入 action
ALIAS_DEFAULT_PARAMS: { read_pdf: { action: 'read', format: 'pdf' }, ... }
```

位置: `src/host/tools/registry.ts`、`src/host/tools/modules/index.ts` 与各 `.schema.ts`

---

## DocEdit 统一文档编辑

**位置**: `src/host/tools/modules/document/docEdit.ts`

DocEdit 是 Excel/PPT/Word 三种格式的统一入口，根据文件扩展名自动路由到对应的编辑器。所有编辑均为原子操作（替代全文件重写），Token 节省约 80%。

### 路由逻辑

```
DocEdit({ file_path, operations })
  │
  ├─ .xlsx/.xls → executeExcelEdit()    ← 14 种原子操作
  ├─ .docx      → executeDocxEdit()     ← 7 种原子操作
  └─ .pptx      → ppt_edit (via registry) ← 8 种操作
```

### Excel 原子编辑（14 种操作）

**位置**: `src/host/tools/excel/excelEdit.ts`

| 操作 | 说明 |
|------|------|
| `set_cell` | 设置单元格值和格式 |
| `set_range` | 批量设置区域值 |
| `set_formula` | 设置公式 |
| `insert_rows` | 插入行 |
| `delete_rows` | 删除行 |
| `insert_columns` | 插入列 |
| `delete_columns` | 删除列 |
| `set_style` | 设置样式（字体/填充/对齐/边框） |
| `rename_sheet` | 重命名工作表 |
| `add_sheet` | 新增工作表 |
| `delete_sheet` | 删除工作表 |
| `set_column_width` | 设置列宽 |
| `merge_cells` | 合并单元格 |
| `auto_filter` | 设置自动筛选 |

依赖: ExcelJS 库。支持 `dry_run` 模式预览变更。

### Word 原子编辑（历史能力）

**当前位置**: native 入口走 `src/host/tools/modules/document/docEdit.ts`。旧 `src/host/tools/document/docxEdit.ts` 路径已不再作为当前事实源。

| 操作 | 说明 |
|------|------|
| `replace_text` | 全局/首次替换文本 |
| `replace_paragraph` | 按索引替换段落 |
| `insert_paragraph` | 在指定位置插入段落 |
| `delete_paragraph` | 删除段落 |
| `replace_heading` | 替换标题文本（保留样式） |
| `append_paragraph` | 追加段落到文档末尾 |
| `set_text_style` | 设置文本样式（加粗/斜体/颜色） |

实现方式: JSZip 直接操作 `word/document.xml`，不依赖 Office 运行时。

### PPT 编辑（8 种操作）

**位置**: `src/host/tools/modules/network/pptEdit.ts`（执行入口）；`src/host/tools/media/ppt/`（生成、版式与设计引擎）

| 操作 | 说明 |
|------|------|
| `replace_title` | 替换指定页标题 |
| `replace_content` | 替换指定页正文 |
| `replace_slide` | 用新内容替换整张幻灯片 |
| `delete_slide` | 删除指定页 |
| `insert_slide` | 插入新页（建议用 /ppt 重新生成） |
| `extract_style` | 提取 PPTX 主题样式 |
| `reorder_slides` | 调整幻灯片顺序 |
| `update_notes` | 更新演讲者备注 |

实现方式: JSZip 操作 PPTX 内部 XML。

---

## SnapshotManager 文档快照层

**位置**: `src/host/tools/document/snapshotManager.ts`

二进制文档（xlsx/pptx/docx）无法通过 git diff 追踪变更，SnapshotManager 提供编辑前自动备份和失败自动回滚能力。

### 核心特性

- **自动快照**: 每次 DocEdit/ExcelEdit/PPT Edit 执行前自动调用 `createSnapshot()`
- **失败回滚**: catch 块中调用 `restoreLatest()` 自动恢复到编辑前状态
- **容量控制**: 每个文件最多保留 20 个快照（`MAX_SNAPSHOTS_PER_FILE`），超出自动清理最旧的
- **存储位置**: 文件所在目录下的 `.doc-snapshots/` 子目录

### API

| 方法 | 说明 |
|------|------|
| `createSnapshot(filePath, description)` | 创建快照，返回 Snapshot 对象 |
| `restoreSnapshot(snapshotId, filePath)` | 恢复到指定快照 |
| `restoreLatest(filePath)` | 恢复到最近一次快照 |
| `listSnapshots(filePath)` | 列出所有快照 |
| `cleanup(filePath, maxSnapshots?)` | 清理旧快照 |
| `clearSnapshots(filePath)` | 删除所有快照 |

### 快照元数据

每个文件对应一个 `.meta.json`，记录快照列表（id、路径、时间戳、描述、大小）。

---

## ExcelAutomate 统一 Excel 工具

**位置**: `src/host/tools/excel/`

将 Excel 生成、原子编辑、xlwings 实时操作整合为单一入口：

| action | 来源 | 说明 |
|--------|------|------|
| `generate` | excel_generate | 生成新 Excel 文件 |
| `edit` | excel_edit (excelEdit.ts) | 14 种原子编辑操作 |
| `automate` | xlwings_execute | 通过 xlwings 实时操作打开的 Excel |
| `read` | read_xlsx | 读取 Excel 内容 |
| `list_sheets` | - | 列出工作表 |
| `read_range` | - | 读取指定区域 |

---

## Skill 系统

### Skill 元工具（skillMetaTool）

**位置**: `src/host/tools/modules/skill/skill.ts`

Skill 是核心工具（始终可见），采用 `dynamicDescription` 在运行时聚合所有可用 skills 的名称和描述到工具描述中，对标 Anthropic 的 `<available_skills>` 机制。

**执行模式**:

| 模式 | 说明 |
|------|------|
| `inline` | 通过消息注入（newMessages + contextModifier）执行，支持 allowed-tools 预授权 |
| `fork` | 通过 SubagentExecutor 在隔离环境中执行 |

### Skill 发现服务（SkillDiscoveryService）

**位置**: `src/host/services/skills/skillDiscoveryService.ts`

多来源发现，优先级从低到高：

```
内置 Skills (builtinSkills.ts + 云端配置)
  → 用户级 (~/.claude/skills/ → ~/.code-agent/skills/)
    → 远程库 (~/.code-agent/skills/ 下的 .meta.json 库)
      → 项目级 (.claude/skills/ → .code-agent/skills/)
```

发现完成后自动注册到 ToolSearchService，使模型可通过 `ToolSearch` 工具发现可用 skills。

### Combo Skills（录制和复用）

**位置**: `src/host/services/skills/comboRecorder.ts`

从对话中自动录制工具调用序列，固化为可复用的 SKILL.md：

1. **录制**: 监听 EventBus 的 `agent:tool_call_end` 事件，逐步记录工具名、参数、结果
2. **建议**: 当录制达到阈值（>=2 轮对话、>=3 步工具调用）时，自动建议保存为 Combo Skill
3. **保存**: 生成 SKILL.md 文件，包含 frontmatter（name/description/allowed-tools/metadata）和工作流步骤
4. **复用**: 保存后的 Skill 通过 SkillDiscoveryService 自动发现，可通过 Skill 元工具调用

### Experience distillation skill drafts（2026-06-12）

经验沉淀管线可以把高频成功工具序列整理成待确认 skill 草稿，但这条链路只负责建议，不自动安装。`skillDraftQueue.ts` 在写 `~/.code-agent/skill-drafts/` 之前会再做名称质量检查：如果名称只是机械工具 token 串，例如 `grep-read-edit`、`bash-bash-bash`，直接拒绝入队。

可接受的草稿名要描述用户价值或工作流语义，例如 `source-change-workflow` 这类能表达"源码变更流程"的名称。确认后才会写入正式 `skills/`；未确认草稿不会被 SkillDiscoveryService 当成可调用 skill。

---

## 规划 & 任务工具

| 工具 | 功能 | 说明 |
|------|------|------|
| `TaskManager` | 任务 CRUD | 统一工具，action: create/get/list/update |
| `Plan` | 计划读写 | 统一工具，action: read/update/recover_recent_work |
| `PlanMode` | 规划模式切换 | 统一工具，action: enter/exit |
| `AskUserQuestion` | 用户交互 | 核心工具 |
| `Task` | 子代理委托 | 延迟工具，启动子代理执行复杂任务 |
| `confirm_action` | 确认操作 | 延迟工具 |
| `findings_write` | 记录发现 | 延迟工具 |

## Web & 搜索工具

| 工具 | 功能 | 说明 |
|------|------|------|
| `WebSearch` | 网络搜索（Brave Search API） | 核心工具 |
| `WebFetch` | 网页抓取/HTTP 请求 | 统一工具 |
| `ReadDocument` | 文档读取（PDF/Word/Excel） | 统一工具 |
| `Skill` | 技能元工具 | 核心工具，动态描述 |
| `lsp` | LSP 语言服务 | 延迟工具 |

## 文档 & 媒体生成 + 记忆工具

| 工具 | 功能 |
|------|------|
| `DocEdit` | 统一文档编辑（Excel/PPT/Word 原子操作） |
| `ExcelAutomate` | Excel 自动化（生成/编辑/xlwings/读取） |
| `ppt_edit` | PPT 编辑（8 种操作） |
| `image_generate` | AI 生图 |
| `video_generate` | AI 生视频 |
| `chart_generate` | 图表生成 |
| `MemoryWrite` / `MemoryRead` | Light Memory（File-as-Memory） |

## 视觉 & 浏览器工具

| 工具 | 功能 | 说明 |
|------|------|------|
| `Computer` | 截图/鼠标/键盘 | 统一工具，action: screenshot/use |
| `Browser` | 浏览器自动化 | 统一工具，action: navigate/action |
| `gui_agent` | GUI 自动化代理 | UI-TARS 视觉模型驱动 |

## 多 Agent 工具

| 工具 | 功能 | 别名 |
|------|------|------|
| `AgentSpawn` | 生成子代理（支持并行模式） | spawn_agent |
| `AgentMessage` | 代理间通信 | agent_message |
| `WaitAgent` | 等待子代理完成（支持超时） | wait_agent |
| `CloseAgent` | 取消运行中的子代理 | close_agent |
| `SendInput` | 向运行中子代理发送消息 | send_input |
| `WorkflowOrchestrate` | 工作流编排 | workflow_orchestrate |

### SpawnGuard 并发守卫 (v0.16.55+)

**位置**: `src/host/agent/spawnGuard.ts`

借鉴 Codex CLI 的 `guards.rs`，RAII 风格的子代理并发管理：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `maxAgents` | 6 | 最大同时运行子代理数 |
| `maxDepth` | 1 | 最大嵌套深度（子代理不能再 spawn 子代理） |

**禁用工具（19 个）**：`spawn_agent`, `AgentSpawn`, `agent_message`, `AgentMessage`, `wait_agent`, `WaitAgent`, `close_agent`, `CloseAgent`, `send_input`, `SendInput`, `ask_user_question`, `AskUserQuestion`, `workflow_orchestrate`, `WorkflowOrchestrate`, `teammate`, `Teammate`, `Task`, `plan_review`, `PlanReview`

**只读角色额外禁用**（explorer, reviewer）：`write_file`, `Write`, `edit_file`, `Edit`

**异步通知机制**：
```
Agent 完成 → promise.then → fireOnComplete()
  → pendingNotifications 队列
  → contextAssembly 每轮 drainNotifications()
  → 注入 <subagent_notification> XML 到父 agent
```

### DAG 任务调度系统 (v0.16+)

**位置**: `src/host/scheduler/`

基于有向无环图（DAG）的并行任务调度系统，自动分析任务依赖关系并最大化并行执行。

**核心组件**:

| 组件 | 文件 | 功能 |
|------|------|------|
| DAGScheduler | `DAGScheduler.ts` | DAG 调度器核心 |
| TaskStateManager | `TaskStateManager.ts` | 任务状态机管理 |
| DependencyResolver | `DependencyResolver.ts` | 依赖解析和拓扑排序 |
| ResourceLimiter | `ResourceLimiter.ts` | 并发资源限制 |

**任务状态机**:

```
pending → ready → running → completed
                       ↘ failed
                       ↘ cancelled
                       ↘ skipped
```

**失败策略**: `fail-fast`（立即停止）| `continue`（继续无依赖任务）| `retry-then-continue`

### 内置 Agent 角色 (v0.16+)

**位置**: `src/shared/types/builtInAgents.ts` + `src/host/agent/hybrid/coreAgents.ts`

**核心角色（CoreAgentId, 5 个）**：

| 角色 | 后缀 | 描述 | 工具限制 |
|------|------|------|----------|
| `coder` | `-coder` | 编写代码 | 全工具（Git worktree 隔离） |
| `reviewer` | `-reviewer` | 代码审查 | 只读（禁 Write/Edit） |
| `explore` | `-explorer` | 代码库搜索 | 只读（禁 Write/Edit） |
| `plan` | `-planner` | 任务规划 | 只读 |
| `awaiter` | `-awaiter` | 等待其他 agent | 最小工具集 |

**扩展角色（11 个）**：

| 角色 | 描述 | 可用工具 |
|------|------|----------|
| `tester` | 编写测试 | Bash, Read, Write, Edit, Glob |
| `architect` | 架构设计 | Read, Glob, Grep, Write |
| `debugger` | 调试问题 | Bash, Read, Edit, Glob, Grep |
| `documenter` | 编写文档 | Read, Write, Edit, Glob |
| `refactorer` | 代码重构 | Bash, Read, Write, Edit, Glob, Grep |
| `devops` | CI/CD 基础设施 | Bash, Read, Write, Edit |
| `visual-understanding` | 图片分析 | 视觉模型 |
| `visual-processing` | 图片编辑 | 图片工具 |
| `web-search` | 网络搜索 | WebSearch, WebFetch |
| `mcp-connector` | MCP 服务连接 | MCPUnified |
| `doc-reader` | 文档读取 | ReadDocument |

## 实验性工具（Feature Flag 控制）

以下工具默认禁用，需要通过 Feature Flag 启用：

| 工具 | 功能 | 权限 |
|------|------|------|
| `strategy_optimize` | 策略优化 | - |
| `tool_create` | 动态创建工具 | execute |
| `self_evaluate` | 自我评估 | - |
| `learn_pattern` | 学习模式 | - |
| `code_execute` | 沙箱执行 JS（循环/条件调用工具） | execute |

---

## 文件结构

```
src/host/tools/
├── registry.ts           # ToolRegistry：schema / loader / handler 三段式注册
├── types.ts              # Tool/ToolContext/ToolExecutionResult 类型
├── modules/              # native ToolModule 主体（schema eager、implementation lazy）
│   ├── index.ts          # 108 个 ToolModule 注册入口
│   ├── file/             # Read / Write / Edit / MultiEdit / Glob / Blob ...
│   ├── shell/            # Bash / Process / commandPolicy
│   ├── search/           # ToolSearch
│   ├── skill/            # Skill / skillCreate
│   ├── lsp/              # LSP / diagnostics
│   ├── document/         # DocEdit
│   ├── excel/            # ExcelAutomate
│   ├── mcp/              # MCP invoke/add/unified
│   ├── multiagent/       # AgentSpawn / WaitAgent / SendInput ...
│   ├── planning/         # Plan / TaskManager / AskUserQuestion ...
│   ├── network/          # WebFetch / WebSearch / media/docgen/PPT schema
│   └── vision/           # Computer / Browser / gui_agent / visual_edit
├── dispatch/             # ToolResolver，含 MCP dynamic direct execute
├── file/                 # 文件操作工具
│   ├── readFile.ts
│   ├── writeFile.ts
│   ├── editFile.ts
│   ├── glob.ts
│   ├── listDirectory.ts
│   ├── readClipboard.ts
│   └── notebookEdit.ts
├── shell/                # Shell 工具
│   ├── bash.ts
│   ├── grep.ts
│   └── ProcessTool.ts    #   统一进程管理
├── document/             # 文档辅助能力（outline / snapshot）
│   └── snapshotManager.ts
├── excel/                # Excel 工具
│   ├── excelEdit.ts           # Excel 原子编辑（14 种操作）
│   └── index.ts               # ExcelAutomate 统一入口
├── media/ppt/            # PPT 生成、版式、设计、预览与视觉评审
├── vision/               # 视觉交互工具
│   ├── BrowserTool.ts         # 统一浏览器
│   └── ComputerTool.ts        # 统一计算机控制
├── lsp/                  # LSP 语言服务
├── decorators/           # 工具装饰器
├── middleware/            # 工具中间件
└── utils/                # 工具辅助函数
```

## Skill 系统文件结构

```
src/host/services/skills/
├── index.ts                   # 统一导出
├── skillDiscoveryService.ts   # 多来源发现（内置→用户→库→项目）
├── skillParser.ts             # SKILL.md 解析器
├── skillLoader.ts             # 懒加载 + 依赖检查
├── skillRenderer.ts           # 内容渲染（!cmd / $ARGUMENTS）
├── builtinSkills.ts           # 内置 Skills
├── skillBridge.ts             # 云端 Skill 桥接
├── skillRepositories.ts       # 推荐仓库 + 关键词映射
├── skillRepositoryService.ts  # 远程仓库管理（下载/更新/删除）
├── sessionSkillService.ts     # 会话级 Skill 状态
├── skillWatcher.ts            # 文件变更监听 + 自动热重载
├── comboRecorder.ts           # Combo Skills 录制器
└── gitDownloader.ts           # GitHub 仓库下载
```

## 权限级别

| 级别 | 说明 | 默认行为 |
|------|------|----------|
| `read` | 只读操作 | 自动批准 |
| `write` | 文件写入 | 需要确认 (开发模式可自动) |
| `execute` | 命令执行 | 需要确认 |
| `network` | 网络请求 | 需要确认 |
