# `src/host` 目录边界

`src/host` 是 Agent Neo 的后端主进程。这里包含 40 多个一级子域，新增代码前先用本页判断归属，再到 [源码地图](../../docs/architecture/source-map.md) 查具体入口。

## 容易混淆的边界

| 目录 | 负责什么 | 不放什么 |
|------|----------|----------|
| `agent/` | 单次 Agent run 的执行循环、消息处理、上下文装配和子 Agent 执行 | 通用后台任务、定时触发、跨 run 的持久服务 |
| `orchestration/` | 多执行单元之间的图编排和协调协议 | 单个工具实现、具体 provider 适配 |
| `task/` | 后台任务账本、并发闸、任务状态和恢复 | DAG 算法、cron 时间触发 |
| `scheduler/` | DAG 依赖调度 | 定时任务和心跳 |
| `cron/` | 时间触发、周期任务和心跳 | 普通后台任务状态 |
| `runtime/` | Node、Playwright、native helper 等运行时资产的发现和安装 | Agent run 状态机、模型调用逻辑 |
| `services/` | 有明确生命周期或持久化边界、可被多个入口复用的应用服务 | 工具 schema、工具 dispatch、纯 UI 契约 |
| `tools/` | 模型可调用工具的注册、权限执行、dispatch 和具体 ToolModule | 长生命周期业务服务；这类实现放进 `services/`，工具只做适配 |
| `ipc/` | renderer 与 host 之间的 handler 适配 | 业务规则和持久化实现 |
| `protocol/` | 跨执行内核共享的命令与事件协议 | provider 或 UI 专属逻辑 |

## 放置规则

1. 优先扩展已有子域。新增 `src/host/<domain>/` 前，先确认现有 45 个一级目录都无法承载它。
2. 工具入口保持薄层：参数校验、权限和结果映射留在 `tools/`，可复用业务逻辑放在对应 service/domain。
3. IPC、Web route、CLI command 都是适配层，不在入口层复制业务规则。
4. 跨前后端的数据结构放在 `src/shared/contract/`，host 内部类型留在所属子域。
5. 新增目录或改变职责时，同步更新本页和 [source-map.md](../../docs/architecture/source-map.md)。

## 常用导航

- Agent 与上下文：`agent/`、`context/`、`prompts/`
- 工具与权限：`tools/`、`permissions/`、`security/`
- 模型与执行引擎：`model/`、`services/agentEngine/`
- 多 Agent 与持久任务：`orchestration/`、`task/`、`scheduler/`、`handoff/`
- 会话与数据：`session/`、`services/core/`、`services/core/repositories/`
- 平台接入：`platform/`、`desktop/`、`connectors/`、`mcp/`、`plugins/`
