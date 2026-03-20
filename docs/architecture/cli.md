# CLI 架构

> Code Agent CLI — 完整的非 UI Agent 运行时
> ~8600 行 TypeScript，20 个文件，5 种运行模式

## 启动流程

```
ca [command] [options]
  │
  ▼ process.env.CODE_AGENT_CLI_MODE = 'true'
  │
  ▼ Commander.js 解析命令 + 全局选项
  │
  ▼ bootstrap.initializeCLIServices()
  │   ├── 注入 electron-mock（防 native 模块报错）
  │   ├── 创建 ~/.code-agent/ 数据目录
  │   ├── ConfigService（.env → API Key）
  │   ├── Database（better-sqlite3, WAL 模式）
  │   ├── SessionManager（内存 + DB 混合）
  │   ├── AgentLoop + ToolRegistry（延迟导入）
  │   ├── MemoryService（可选）
  │   └── SkillDiscoveryService（可选）
  │
  ▼ CLIAgent (adapter.ts) 包装 AgentLoop
  │   ├── 创建会话 → 挂载 skills
  │   ├── 事件处理 → 输出路由
  │   └── Token 追踪 → 成本计算
  │
  ▼ 命令执行 → 输出 → cleanup()
```

**优雅降级**：Database/Memory 初始化失败不阻止运行，只影响持久化。

---

## 5 种运行模式

| 模式 | 命令 | 定位 | 入口 |
|------|------|------|------|
| **交互对话** | `ca chat` | 人工 REPL | `commands/chat.ts` |
| **单次执行** | `ca run <prompt>` | 脚本集成 | `commands/run.ts` |
| **HTTP API** | `ca serve` | 远程调用 | `commands/serve.ts` |
| **工具直调** | `ca exec-tool <name>` | 绕过 Agent | `commands/execTool.ts` |
| **MCP Server** | `ca mcp-server` | 被其他 AI 调用 | `commands/mcpServer.ts` |

辅助命令：`ca list-tools`、`ca list-agents`、`ca export`

---

## 核心架构

### CLIAgent 适配层

**位置**: `src/cli/adapter.ts` (~17K)

CLI 的核心类，将 AgentLoop 事件流适配到 CLI 输出：

```
AgentLoop Events → CLIAgent.handleEvent()
    ├─ text        → TerminalOutput（终端渲染，Spinner + 颜色）
    ├─ json        → JSONOutput（事件累积 → 结构化 JSON）
    └─ stream-json → 直接输出 JSONL（HTTP SSE 流式响应）
```

**关键能力**：
- `run(prompt)` → 执行单次任务，返回 `CLIRunResult`
- `cancel()` → ESC/Ctrl+C 中断
- `setModel(provider, model)` → 动态切换模型
- `restoreSession(sessionId)` → 恢复历史会话
- `injectContext(context)` → 注入上下文为系统消息
- `setPRLink(link)` → PR 关联

**Token 追踪**：从 `stream_usage` + `model_response` 事件累计真实 token，用于 `/cost` 和 `--metrics`。

**多 Agent 追踪**：`pendingAgentCalls` 映射 spawn_agent 工具调用 ID，分发 `agent_dispatch`/`agent_result` 事件。

### 输出格式化

| 组件 | 位置 | 功能 |
|------|------|------|
| **TerminalOutput** | `output/terminal.ts` (~28K) | 欢迎横幅、Spinner 动效（♠♥♣♦）、彩色渲染、Swarm 状态 |
| **JSONOutput** | `output/json.ts` (~3.6K) | NDJSON 逐行输出、事件类型映射 |

**stream-json 事件类型**（用于 HTTP API SSE）：
- `text` — 流式内容
- `tool_start` / `tool_result` — 工具执行
- `agent_dispatch` / `agent_result` — 子代理调度
- `model_call` — 推理决策（duration, tokens）
- `turn_start` / `turn_end` — 回合边界
- `done` — 完成

---

## 命令详解

### chat — 交互式对话

```bash
ca chat [--model moonshot/kimi-k2.5] [--from-pr <url>]
```

**斜杠命令**：

| 命令 | 功能 |
|------|------|
| `/login [provider]` | API Key 配置（masked input） |
| `/model [p/m]` | 列出/切换模型 |
| `/cost` | Token 用量 + 成本估算 |
| `/tools` | 列出已加载工具 |
| `/skills` | 列出已挂载 skill |
| `/sessions` | 列出最近会话 |
| `/restore <id>` | 恢复历史会话 |
| `/config` | 当前配置 |
| `/clear` | 清屏 |
| `!cmd` | Shell 快捷方式 |

**PR 支持**：`--from-pr <url>` 解析 GitHub PR，通过 `gh` CLI 获取信息并注入上下文。

### run — 单次执行

```bash
ca run "实现用户登录功能" [--output-schema schema.json] [--max-retries 3]
echo "分析这段代码" | ca run --json
```

**结构化输出验证**：
1. 提取 JSON（代码块 → 全文 → 大括号范围）
2. Schema 验证（轻量级，无外部依赖）
3. 失败重试（附加验证错误到 prompt）

### serve — HTTP API

```bash
ca serve [--port 3456]
```

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/run` | POST | 执行任务（SSE 流式响应） |
| `/api/status` | GET | 当前状态 |
| `/api/cancel` | POST | 中止任务 |
| `/api/health` | GET | 健康检查 |

### mcp-server — MCP Server

```bash
ca mcp-server [--transport stdio|http] [--enable-write-tools]
```

将 Code Agent 暴露为 MCP Server，供其他 AI 工具调用。默认只读，`--enable-write-tools` 启用写入。

---

## 数据层

### 配置 (`config.ts`)

- 优先 `CWD/.env` → `~/.code-agent/.env`
- Provider → 环境变量名映射
- 单例 `getCLIConfigService()`

### 数据库 (`database.ts`)

SQLite (better-sqlite3)，4 张表：

| 表 | 用途 |
|----|------|
| `sessions` | 会话元数据（id, title, model, working_directory, status, pr_link） |
| `messages` | 消息存储（role, content, tool_calls, tool_results） |
| `tool_executions` | 工具结果缓存（arguments_hash, expires_at） |
| `todos` | 待办事项 |

### 会话 (`session.ts`)

内存 + 数据库混合，数据库不可用自动降级为纯内存模式。

---

## CLI vs Tauri App

| 维度 | CLI | Tauri App |
|------|-----|-----------|
| 启动 | 无 UI，进程结束退出 | 持久窗口 |
| 会话 | 短生命周期或 REPL | 跨关闭保存 |
| 输出 | 终端 / JSON / HTTP SSE | React UI + IPC |
| 工具批准 | 可自动批准 | 用户交互式 |
| 数据存储 | SQLite 本地 | + Supabase 云同步 |
| 模块加载 | 延迟导入（减启动时间） | 预加载 |
| 平台 API | electron-mock 空操作 | 真实 Tauri/Electron API |

---

## 与主应用的集成点

| 复用模块 | 说明 |
|---------|------|
| AgentLoop | 完全复用主应用的 Agent 循环 |
| ToolRegistry + ToolExecutor | 相同的工具定义和执行引擎 |
| SkillDiscoveryService | 自动发现和挂载 skills |
| ModelRouter (constants) | 共用价格表、超时值、上下文窗口 |
| MemoryService | 可选的 RAG 和长期记忆 |
| TelemetryCollector | 会话数据、token 使用、错误追踪 |

---

## 文件结构

```
src/cli/
├── index.ts               # 入口（Commander.js 命令注册）
├── bootstrap.ts           # 服务初始化（无 Electron 依赖）
├── adapter.ts             # CLIAgent 适配层（事件流 → 输出）
├── config.ts              # 配置服务（.env + API Key）
├── database.ts            # SQLite 数据库层
├── session.ts             # 会话管理器
├── electron-mock.ts       # Electron API Mock
├── types.ts               # CLI 类型定义
├── commands/
│   ├── index.ts           # 命令导出
│   ├── chat.ts            # 交互式对话（REPL + 斜杠命令）
│   ├── run.ts             # 单次执行（+ 结构化输出验证）
│   ├── serve.ts           # HTTP API（SSE 流式响应）
│   ├── export.ts          # 会话导出（Markdown/JSON）
│   ├── execTool.ts        # 工具直调
│   ├── listTools.ts       # 列出工具
│   ├── listAgents.ts      # 列出 Agent 角色
│   └── mcpServer.ts       # MCP Server 模式
├── output/
│   ├── index.ts           # 导出聚合
│   ├── terminal.ts        # 终端渲染（Spinner + 颜色）
│   └── json.ts            # JSON/NDJSON 输出
└── utils/
    ├── jsonExtractor.ts   # JSON 提取（三层策略）
    └── schemaValidator.ts # 轻量级 JSON Schema 验证
```
