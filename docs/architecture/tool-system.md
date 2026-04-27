# 工具系统架构

> ToolRegistry + ToolExecutor + Core/Deferred 双层 + 统一工具合并

## 工具定义格式

**位置**: `src/main/tools/`

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

- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/mcp/mcpClient.ts`
- `src/main/protocol/dispatch/toolResolver.ts`
- `tests/unit/protocol/toolResolver.mcpDirect.test.ts`
- `tests/unit/tools/toolExecutor.mcpDirect.test.ts`

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

---

## Core / Deferred 双层架构

工具分为 **核心工具**（始终发送给模型）和 **延迟工具**（按需通过 ToolSearch 发现加载）。

**位置**: `src/main/tools/search/deferredTools.ts`

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

### 延迟工具（DEFERRED_TOOLS_META）

不随每次请求发送，模型需要时通过 `ToolSearch` 按名称/关键词/别名搜索加载。每个延迟工具注册了 `name`、`shortDescription`、`tags`、`aliases` 用于搜索匹配。

---

## 工具分类总览（96 个注册工具）

| 分类 | 数量 | 代表工具 |
|------|------|----------|
| Shell & 文件 | 14 | Bash, Read, Write, Edit, Glob, Grep, GitCommit, NotebookEdit |
| 规划 & 任务 | 12 | TaskManager, Plan, PlanMode, AskUserQuestion, Task |
| Web & 搜索 | 5 | WebSearch, WebFetch, ReadDocument, LSP, Diagnostics |
| 文档 & 媒体 | 23 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart/QRCode, Speech |
| 外部服务连接器 | 13 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | 2 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | 5 | Computer, Browser, Screenshot, GuiAgent |
| 多 Agent | 9 | AgentSpawn, AgentMessage, WaitAgent, CloseAgent, SendInput, Teammate |
| 统一入口 (Deferred) | 12 | Process, MCPUnified, DocEdit, ExcelAutomate, PdfAutomate |
| 元工具 | 1 | ToolSearch |

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

位置: `src/main/tools/toolRegistry.ts`

---

## DocEdit 统一文档编辑

**位置**: `src/main/tools/document/docEditTool.ts`

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

**位置**: `src/main/tools/excel/excelEdit.ts`

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

### Word 原子编辑（7 种操作）

**位置**: `src/main/tools/document/docxEdit.ts`

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

**位置**: `src/main/tools/network/ppt/editTool.ts`

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

**位置**: `src/main/tools/document/snapshotManager.ts`

二进制文档（xlsx/pptx/docx）无法通过 git diff 追踪变更，SnapshotManager 提供编辑前自动备份和失败自动回滚能力。

### 核心特性

- **自动快照**: 每次 DocEdit/ExcelEdit/DocxEdit/PPT Edit 执行前自动调用 `createSnapshot()`
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

**位置**: `src/main/tools/excel/`

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

**位置**: `src/main/tools/skill/skillMetaTool.ts`

Skill 是核心工具（始终可见），采用 `dynamicDescription` 在运行时聚合所有可用 skills 的名称和描述到工具描述中，对标 Anthropic 的 `<available_skills>` 机制。

**执行模式**:

| 模式 | 说明 |
|------|------|
| `inline` | 通过消息注入（newMessages + contextModifier）执行，支持 allowed-tools 预授权 |
| `fork` | 通过 SubagentExecutor 在隔离环境中执行 |

### Skill 发现服务（SkillDiscoveryService）

**位置**: `src/main/services/skills/skillDiscoveryService.ts`

多来源发现，优先级从低到高：

```
内置 Skills (builtinSkills.ts + 云端配置)
  → 用户级 (~/.claude/skills/ → ~/.code-agent/skills/)
    → 远程库 (~/.code-agent/skills/ 下的 .meta.json 库)
      → 项目级 (.claude/skills/ → .code-agent/skills/)
```

发现完成后自动注册到 ToolSearchService，使模型可通过 `ToolSearch` 工具发现可用 skills。

### Combo Skills（录制和复用）

**位置**: `src/main/services/skills/comboRecorder.ts`

从对话中自动录制工具调用序列，固化为可复用的 SKILL.md：

1. **录制**: 监听 EventBus 的 `agent:tool_call_end` 事件，逐步记录工具名、参数、结果
2. **建议**: 当录制达到阈值（>=2 轮对话、>=3 步工具调用）时，自动建议保存为 Combo Skill
3. **保存**: 生成 SKILL.md 文件，包含 frontmatter（name/description/allowed-tools/metadata）和工作流步骤
4. **复用**: 保存后的 Skill 通过 SkillDiscoveryService 自动发现，可通过 Skill 元工具调用

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
| `SdkTask` | SDK 兼容任务执行 | — |

### SpawnGuard 并发守卫 (v0.16.55+)

**位置**: `src/main/agent/spawnGuard.ts`

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

**位置**: `src/main/scheduler/`

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

**位置**: `src/shared/types/builtInAgents.ts` + `src/main/agent/hybrid/coreAgents.ts`

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
src/main/tools/
├── toolRegistry.ts       # 工具注册表 + TOOL_ALIASES + ALIAS_DEFAULT_PARAMS
├── types.ts              # Tool/ToolContext/ToolExecutionResult 类型
├── search/               # ToolSearch 延迟加载系统
│   ├── deferredTools.ts  #   CORE_TOOLS + DEFERRED_TOOLS_META
│   └── toolSearchService.ts
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
├── planning/             # 规划工具
│   ├── askUserQuestion.ts
│   ├── confirmAction.ts
│   ├── findingsWrite.ts
│   ├── TaskManagerTool.ts #  统一任务 CRUD
│   ├── PlanTool.ts        #  统一计划读写
│   └── PlanModeTool.ts    #  统一规划模式
├── network/              # 网络工具
│   ├── WebFetchUnifiedTool.ts # 统一网页获取
│   ├── ReadDocumentTool.ts    # 统一文档读取
│   ├── webSearch.ts
│   └── ppt/
│       └── editTool.ts        # PPT 编辑（8 种操作）
├── document/             # 文档编辑
│   ├── docEditTool.ts         # DocEdit 统一入口
│   ├── docxEdit.ts            # Word 原子编辑（7 种操作）
│   └── snapshotManager.ts     # 文档快照管理
├── excel/                # Excel 工具
│   ├── excelEdit.ts           # Excel 原子编辑（14 种操作）
│   └── index.ts               # ExcelAutomate 统一入口
├── mcp/                  # MCP 协议工具
│   └── MCPUnifiedTool.ts      # 统一 MCP 操作
├── connectors/           # macOS 原生连接器
│   ├── calendar*.ts
│   ├── mail*.ts
│   └── reminders*.ts
├── memory/               # 记忆系统工具
├── vision/               # 视觉交互工具
│   ├── BrowserTool.ts         # 统一浏览器
│   └── ComputerTool.ts        # 统一计算机控制
├── skill/                # Skill 元工具
│   └── skillMetaTool.ts
├── multiagent/           # 多代理工具
│   ├── spawnAgent.ts     #   spawn_agent（支持并行模式 + worktree 隔离）
│   ├── waitAgent.ts      #   wait_agent（等待子代理完成）
│   ├── closeAgent.ts     #   close_agent（取消子代理）
│   ├── sendInput.ts      #   send_input（向子代理发消息）
│   └── index.ts
├── lsp/                  # LSP 语言服务
├── decorators/           # 工具装饰器
├── middleware/            # 工具中间件
└── utils/                # 工具辅助函数
```

## Skill 系统文件结构

```
src/main/services/skills/
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
