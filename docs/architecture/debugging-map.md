# Agent Neo 排障地图

本文给本机排障和支持包复核使用。SQLite 是会话事实源；CLI、日志切片和导出包只做按需读取与投影。所有命令默认只读。

## 落盘地图

| 数据 | 位置 | 写入方 | 格式与用途 |
|---|---|---|---|
| 会话与消息 | `$CODE_AGENT_DATA_DIR/code-agent.db` 的 `sessions`、`messages` | `DatabaseService` / CLI session manager | SQLite；对话事实源，消息关联键在 `messages.metadata.correlation` |
| 五泳道账本 | 同库的 `session_task_events`、`swarm_runs`、`swarm_run_events`、`permission_decisions`、`tool_execution_events` | 各运行时账本 repository | SQLite append-only 小账本；`neo session timeline` 在读取时合并 |
| Telemetry | 同库的 `telemetry_sessions`、`telemetry_turns`、`telemetry_tool_calls`、`telemetry_events` | `TelemetryStorage` | SQLite；会话、turn 和工具聚合。遥测关闭时允许缺席 |
| 运行时压缩状态 | 同库的 `session_runtime_state.compression_state_json` | `SessionRepository` | SQLite JSON；用于定位上下文压缩与恢复问题 |
| 审计 | `$CODE_AGENT_DATA_DIR/audit/YYYY-MM-DD.jsonl` | `AuditLogger` | JSONL；工具输入、输出、风险和成功状态，可能含本机敏感内容 |
| 工程日志 | `$CODE_AGENT_DATA_DIR/logs/code-agent-YYYY-MM-DD.log` | `logger.ts` file sink | JSONL；`lane` 行内区分 `mcp`、`sandbox`、`browser`、`computer-use` 等 |
| 旧日志收集旁路 | `$CODE_AGENT_DATA_DIR/logs/app-*.log` | MCP `LogCollector` | JSONL；旧格式只有 `source/level/message/metadata`，通常没有 correlation，不能当四 sink join 主入口 |
| Turn trace 旁路 | `$CODE_AGENT_DATA_DIR/traces/<sessionId>.jsonl` | `TurnTrace` | JSONL；运行时 turn 调试旁路，不替代 SQLite |
| 按需导出包 | 用户指定目录中的 `neo-session-*.zip` 或 `*-transcript.jsonl` | `spine/packageBuilder` | 从上述事实源临时生成；不常驻镜像、不回写数据库 |

未设置 `CODE_AGENT_DATA_DIR` 时，生产默认目录是 `$HOME/.code-agent`。开发通道可能通过该环境变量指向 `.code-agent-dev`，排障前先确认当前通道。

## ID 怎么贯穿

| ID | 产生点 | 主要用途 |
|---|---|---|
| `sessionId` | 会话创建时 | 限定一次会话；横跨 messages、telemetry、audit 和 app log |
| `turnId` | `conversationRuntime` 每轮开始 | 关联本轮消息、telemetry turn、audit 和 app log |
| `traceId` | `runTraceContext` 创建 W3C trace 时 | 关联同一次运行链和 MCP `traceparent` |
| `toolCallId` | `toolExecutor` 进入工具调用时 | 精确关联 app log、audit、`telemetry_tool_calls` 和 message 工具段 |

先设置数据目录与目标 ID：

```bash
export CODE_AGENT_DATA_DIR="${CODE_AGENT_DATA_DIR:-$HOME/.code-agent}"
export NEO_SESSION_ID='<session-id>'
export NEO_TOOL_CALL_ID='<tool-call-id>'
```

SQLite 查询一条工具关联链：

```bash
sqlite3 -readonly "$CODE_AGENT_DATA_DIR/code-agent.db" "SELECT session_id,turn_id,tool_call_id,name,success,error FROM telemetry_tool_calls WHERE session_id='$NEO_SESSION_ID' AND tool_call_id='$NEO_TOOL_CALL_ID';"
```

在 app log 中按相同 `toolCallId` 查询：

```bash
jq -c "select(.sessionId == env.NEO_SESSION_ID and .toolCallId == env.NEO_TOOL_CALL_ID) | {timestamp,level,lane,context,message,sessionId,turnId,traceId,toolCallId}" "$CODE_AGENT_DATA_DIR"/logs/code-agent-*.log
```

常用只读投影：

```bash
neo session timeline "$NEO_SESSION_ID" --json | jq '{sessionId, laneCounts, turns:(.telemetryTurns|length), entries:(.entries|length)}'
neo session digest "$NEO_SESSION_ID" --json | jq '{sessionId, happenedAt, errorSummary, permissionDenies, tools:(.lastTools|length)}'
```

## 症状到证据源

| 症状 | 先查 | 再查 | 判断要点 |
|---|---|---|---|
| 工具卡死或无结果 | `tool_execution_events` | audit 的 `duration/success/error`、`telemetry_tool_calls` | 同一 `execution_id` 有 `begin` 无 `complete` 表示中断现场；有 `toolCallId` 时再跨四个 sink 精确关联 |
| MCP 报错 | app log 的 `lane="mcp"` | `telemetry_tool_calls.error`、audit | 先按 `sessionId/turnId/toolCallId` 限定，不按关键词扫全盘 |
| Sandbox 命令失败 | app log 的 `lane="sandbox"` | audit、`tool_execution_events` | 对照权限拒绝、exit/error 与执行耗时 |
| 浏览器或电脑操作失败 | app log 的 `lane="browser"` / `lane="computer-use"` | telemetry computer-surface 字段、audit | 区分页面动作、AX/截图质量和权限问题 |
| 权限被拒 | `permission_decisions` | audit `permission_check` | 查看 `final_outcome`、`history_outcome`、`reason`，不要只看工具最终错误 |
| 上下文异常或压缩后丢信息 | `neo session timeline` 的 message lane | `session_runtime_state.compression_state_json`、`turn_snapshots` / `compaction_snapshots` | 对照压缩前后消息数、turn 边界和最后持久化时间 |
| 回答失败但工具都成功 | `telemetry_turns.outcome_status` | messages 的 `metadata.agentError`、app log ERROR | 用 turnId 限定模型调用和最终错误，不把其它轮错误混入 |
| 导出包内容缺失 | `messages` 是否完整 | `manifest.source.hadTelemetrySession`、`manifest.includes` | transcript 必须来自 messages；遥测缺席只影响 telemetry 文件 |

## 安全边界

- 本机查询使用 `sqlite3 -readonly` 或 `neo session` 的 readonly 连接；不要用会执行迁移的应用初始化路径。
- audit、message 和 full-local 导出可能含命令、路径及输出。向外发送默认用 `--privacy shareable`。
- 日志与 `traces/` 是旁路证据，可能轮转或缺失；不能据此否定 SQLite 中已存在的会话事实。
- 排障命令只打印匹配结果。共享验收报告时只报告退出码、结构和计数，不粘贴真实用户内容。
