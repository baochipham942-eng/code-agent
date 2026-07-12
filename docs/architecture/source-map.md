# 源码地图：`src/host`

`src/host` 是后端/主进程，子域较多。本文按**逻辑分组**给每个目录一句话职责，作为「在哪改」的导航。深入设计见 [ARCHITECTURE.md](../ARCHITECTURE.md) 各分册。

> 一级分层（`src/host` / `renderer` / `shared` / `web` / `cli` / `design` / `artifacts`）见仓库根 [README](../../README.md)。
> 新增目录和容易混淆的职责边界见 [`src/host/README.md`](../../src/host/README.md)。

## 常见修改入口

| 想改什么 | 先看哪里 |
|----------|----------|
| Agent 怎么思考、怎么组织上下文、怎么发起一轮对话 | `agent/`、`context/`、`prompts/` |
| 新增或修改一个工具调用 | `tools/`，涉及权限时同时看 `permissions/` 和 `security/` |
| 接一个外部 MCP server | `mcp/` |
| 接本机应用或系统服务，比如日历、邮件、提醒事项 | `connectors/`、`services/connectors/` |
| 做插件安装、插件加载、内置插件工具 | `plugins/` |
| 做技能发现、安装、执行、推荐 | `services/skills/`、`skills/marketplace/` |
| 调模型、provider、执行引擎 | `model/`、`services/agentEngine/` |
| 改后台任务、长任务恢复、多 Agent 编排 | `task/`、`orchestration/`、`scheduler/`、`handoff/` |
| 改定时任务、循环任务、心跳 | `cron/`、`loop/` |
| 改回放、轨迹、遥测查询、实验适配 | `evaluation/`、`telemetry/` |
| 改桌面能力、Computer Use、音频采集 | `src/host/desktop/`，Rust 侧再看 `src-tauri/src/` |
| 改 renderer 和 host 的通信 | `src/host/ipc/`，共享类型通常在 `src/shared/contract/` |

## Agent 运行核心
| 目录 | 职责 |
|------|------|
| `agent/` | Agent Loop 与运行时（`parallelAgentCoordinator`、`subagentExecutor`、`runtime/messageProcessor`、`runtime/contextAssembly`） |
| `loop/` | `/loop` 循环任务控制（`loopController`、`loopPrompt`） |
| `routing/` | 意图分类与路由（`intentClassifier`、`routingService`） |
| `model/` | 模型路由与 provider 适配（`modelRouter`、catalog、fallback 链） |
| `protocol/` | 命令协议层 |
| `planning/` | 自动规划（`autoPlanner`、`feasibilityChecker`、`executionMonitor`、`findingsManager`） |
| `orchestration/` | 多执行单元之间的图编排、统一 runner 和协调协议；单次 Agent Loop 仍归 `agent/` |

## 任务 / 编排 / 会话
| 目录 | 职责 |
|------|------|
| `task/` | 任务子系统：并发闸（`Semaphore`）、`TaskManager`、后台任务账本/恢复/快照（`backgroundTask*`） |
| `scheduler/` | DAG 调度（`DAGScheduler`、`TaskDAG`、`taskDagAlgorithms`）—— 依赖编排，区别于 `cron` 的定时触发 |
| `cron/` | 定时 / 心跳自动化（`cronService`、`heartbeatService`）—— 时间触发，区别于 `scheduler` 的 DAG |
| `handoff/` | 任务交接与长任务恢复提议（`handoffProposalService`、`longTaskRecoveryProposal`） |
| `session/` | 会话生命周期、导出、证据控制摘要 |
| `cowork/` | 人机协作契约（`coworkContract`） |

## 工具 / 能力 / 外部集成
| 目录 | 职责 |
|------|------|
| `tools/` | 工具注册与执行（`toolExecutor`）、media（PPT 等）工具 |
| `skills/` | 技能 marketplace 边界。技能发现、安装、执行的主体在 `services/skills/` |
| `mcp/` | MCP（Model Context Protocol）集成 |
| `connectors/` | 连接器（外部服务 / 原生 app） |
| `plugins/` | 插件系统 |
| `lsp/` | 语言服务（LSP） |
| `desktop/` | 桌面操作 / Computer Use / 音频采集 |
| `sandbox/` | 沙箱执行 |
| `research/` | 研究类工具 |
| `channels/` | 外部消息通道（飞书等，`channelManager`、`channelAgentBridge`） |

## 上下文 / 记忆 / 提示词
| 目录 | 职责 |
|------|------|
| `context/` | 上下文工程（`autoCompressor`、`checkpoint`、compaction 审计） |
| `memory/` | 记忆条目运行时、知识 inbox 决策、注入 trace |
| `lightMemory/` | 轻记忆子系统：会话复盘/评审、`failureJournal`、consolidation、索引（与 `memory` 分层，非重复） |
| `prompts/` | 提示词构建 |

## 质量 / 评测 / 观测
| 目录 | 职责 |
|------|------|
| `evaluation/` | 产品内回放、轨迹、遥测查询、实验适配。外部 benchmark 见 `benchmarks/` 和 `packages/eval-harness/` |
| `quality/` | 产物质量检测（`designQualityHook`、`detect`、`rules`） |
| `observability/` | 可观测性 |
| `telemetry/` | 遥测与诊断存储 |
| `diagnostics/` | 诊断导出 |
| `testing/` | 测试辅助 |
| `hooks/` | 生命周期钩子 |

## 平台 / 基础设施
| 目录 | 职责 |
|------|------|
| `app/` | 应用宿主（`bootstrap`、`createAgentRuntime`、init core/background services） |
| `platform/` | 平台抽象（Electron mock 等跨环境适配） |
| `runtime/` | 运行时资产安装/解析（Playwright、node module loader、asset installer/registry） |
| `ipc/` | IPC domain handlers（renderer ↔ host） |
| `services/` | 各类服务：`core`（database/config/sessionManager）、`infra`、`desktop`、`design`、`agentEngine` 等 |
| `config/` | 配置服务 |
| `security/` | 命令安全、权限路径、平台安全规则包 |
| `permissions/` | 权限决策 |
| `errors/` | 错误处理 |
| `extension/` | 浏览器扩展 host 侧支持 |
| `utils/` | 通用工具函数 |
| `index.ts` · `shellCapabilities.ts` | host 顶层入口 / shell 能力探测 |
