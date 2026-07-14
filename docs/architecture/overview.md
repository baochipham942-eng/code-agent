# Agent Neo / Code Agent 系统架构概览

> 本文档提供 Agent Neo 的高层架构视图。Code Agent 仍是代码仓库与历史包名。

## 2026-07-04~11 架构增量（Run Safety / Collaboration / Goal Trust）

这一周把 Neo 的运行所有权、工具执行、Agent Team 作用域和完成证据收进同一套 fail-closed 合同。完整合同见 [Neo 运行安全与执行可信度 as-built spec](../plans/2026-07-11-neo-runtime-safety-as-built-spec.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Native Run ownership | `RunContext` 冻结 run/session/workspace/cwd；`RunRegistry` 拒绝同 session 双 run；控制和断线绑定精确 RunHandle | [native-run-context.md](./native-run-context.md)、[agent-core.md](./agent-core.md) |
| Tool execution safety | cache 默认关闭并绑定 workspace+session v2 namespace；账本参数先脱敏；残缺 SSE tool call 不执行 | [tool-system.md](./tool-system.md) |
| Agent Team scope | agent、任务、审批、trace、取消和 UI 事件按 `SwarmRunScope` 隔离；跨 run / tree / session target fail-closed | [multiagent-system.md](./multiagent-system.md) |
| Goal completion trust | deliverables 声明、公开证据闸、verify/reviewer infra 故障降级和有界修复进入完成链路 | [agent-core.md](./agent-core.md) |
| Permission profiles | 会话四档权限持久化；readOnly 读放行写/执行确认；无人值守最高钳到 acceptEdits | [tool-system.md](./tool-system.md) |
| Model scaffold profile | strong 模型可减少重复 thinking/nudge/修复指令；当前 flag 默认关，standard 行为不变 | [agent-core.md](./agent-core.md) |
| `@neo` collaboration | tag 直接开干、对话内清单与 topic 目录；topic 可跨会话显式续接，运行中同 topic 拒绝并发续接 | [ADR-034](./decisions/ADR-034-neo-tag-lightweight-conversational.md)、[ADR-035](./decisions/ADR-035-neo-tag-cross-session-topics.md) |
| Context cache economics | 易变上下文进入 transient 尾巴、工具表稳定排序；大 tool result 完整归档后用确定性 placeholder 替换 | [ADR-032](./decisions/ADR-032-request-shape-prefix-stability.md)、[agent-core.md](./agent-core.md) |

## 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Agent Neo Architecture (Tauri 2.x)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Presentation Layer (React 18)                       │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │  │
│  │  │ Chat View    │ │WorkbenchTabs │ │ Live Preview │ │ Settings    │  │  │
│  │  │ + Trace UI   │ │Task/Skills/  │ │ + TweakPanel │ │Conversation │  │  │
│  │  │              │ │Files/Preview │ │              │ │Activity     │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │  │
│  │  │Sidebar User  │ │Semantic Tool │ │ Browser /    │ │Automation   │  │  │
│  │  │Menu          │ │UI + Citation │ │Validation UI │ │/Cron Center │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  │  ┌──────────────┐                                                    │  │
│  │  │Role Draft /  │                                                    │  │
│  │  │Schedule Cards│                                                    │  │
│  │  └──────────────┘                                                    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                            │ Platform Abstraction                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                   Application Layer (Node.js webServer)                │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Agent Orchestrator                          │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │Runtime     │ │   Model    │ │ToolExec /  │ │TaskManager  │  │ │  │
│  │  │  │Lifecycle   │ │  Router    │ │MCP Resolver│ │Run Owner    │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Core Subsystems                             │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │   Light    │ │Capability │ │  Platform  │ │ AgentEngine │  │ │  │
│  │  │  │  Memory    │ │  Center   │ │ Abstraction│ │  Adapters   │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │Task Ledger │ │Structured  │ │Telemetry / │ │Role Assets │  │ │  │
│  │  │  │+ Loop/Cron │ │Replay      │ │Eval Gate   │ │+ Drafts    │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      Tool Layer (108+ native modules, 9 类)            │  │
│  │                                                                        │  │
│  │  Shell & 文件    规划 & 任务      文档 & 媒体      多 Agent            │  │
│  │  ┌──────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐         │  │
│  │  │Bash,Read │   │Task,Plan │    │DocEdit   │    │AgentSpawn│         │  │
│  │  │Write,Edit│   │PlanMode  │    │Excel,PPT │    │WaitAgent │         │  │
│  │  │Glob,Grep │   │AskUser   │    │Image,PDF │    │Teammate  │         │  │
│  │  └──────────┘   └──────────┘    └──────────┘    └──────────┘         │  │
│  │  Web & 搜索     连接器           视觉 & 浏览器   记忆                  │  │
│  │  ┌──────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐         │  │
│  │  │WebSearch │   │Calendar  │    │Computer  │    │Memory    │         │  │
│  │  │WebFetch  │   │Mail      │    │Browser   │    │Write/Read│         │  │
│  │  │ReadDoc   │   │Reminders │    │GuiAgent  │    │          │         │  │
│  │  └──────────┘   └──────────┘    └──────────┘    └──────────┘         │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │  15 核心工具 (始终可见) + 81+ 延迟工具 (ToolSearch 按需加载)      │   │  │
│  │  │  统一入口: Process, MCPUnified, DocEdit, ExcelAutomate 等        │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         External Layer                                 │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────────────┐  │  │
│  │  │ Xiaomi MiMo│ │  GPT-5.5   │ │  DeepSeek  │ │ Claude / GLM /   │  │  │
│  │  │ (default)  │ │  (router)  │ │  (router)  │ │ Kimi / Ollama    │  │  │
│  │  └────────────┘ └────────────┘ └────────────┘ └───────────────────┘  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                       │  │
│  │  │   Ollama   │ │   File     │ │  Network   │                       │  │
│  │  │(本地 Vision)│ │  System    │ │  (HTTP)    │                       │  │
│  │  └────────────┘ └────────────┘ └────────────┘                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 三端产品形态

```
┌─ Web 端（浏览器）──────────────────────┐
│  React 18 + Vite                       │
│  云端功能 → webServer API              │
│  本地功能 → Bridge (localhost:9527)     │
└────────────────────────────────────────┘
┌─ App 端（Tauri 2.x）──────────────────┐
│  Rust Shell → spawn Node.js webServer  │
│  原生自动更新 + capabilities 权限模型   │
│  完整本地能力（文件/Shell/进程/Vision） │
│  DMG ~33MB（vs Electron 742MB）        │
└────────────────────────────────────────┘
┌─ CLI 端 ──────────────────────────────┐
│  Node.js 单文件 (esbuild)             │
│  适合极客和 Agent 调用                 │
└────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **桌面框架** | Tauri 2.x (Rust) | 替代 Electron，DMG 95% 缩减 |
| **前端框架** | React 18 + TypeScript 5.6 | 组件化开发 |
| **状态管理** | Zustand 5 | 轻量级状态管理 |
| **UI 组件** | Tailwind CSS 3.4 | 快速开发 |
| **构建工具** | esbuild (main/preload) + Vite (renderer) | 双构建管线 |
| **IPC 通信** | Platform Abstraction Layer (`src/host/platform/`) | 统一替代直接 Electron 导入，跨平台兼容 |
| **本地存储** | SQLite (better-sqlite3) | 会话/配置持久化 |
| **云端存储** | Supabase + pgvector | 同步 + 向量存储 |
| **AI 模型** | 小米 MiMo v2.5 Pro（默认）/ GPT-5.5 / DeepSeek V4 / Kimi K2.6 / 智谱 / Claude / Ollama | 多模型路由，本地 API Key 优先 |
| **Agent Engine** | Native Agent Neo / Codex CLI / Claude Code | read-only 外部 engine、workspace-only cwd、task ledger 输出回带 |

## 2026-06-24 架构增量（Desktop Shell Operability / Native Runtime / Release Acceptance）

这一轮把 Tauri 壳层、bundled Node、webServer、renderer、runtime assets 和 release smoke 收成同一个可诊断边界。当前合同已经折入 [desktop-shell.md](./desktop-shell.md) 和 [hot-update.md](./hot-update.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Desktop shell diagnostics | `DesktopShellDiagnostics` 聚合 app 版本、启动阶段、webServer health、renderer serve decision、资源 preflight、runtime assets、native permissions、channel isolation、repair actions 和 issues；入口复用 `diagnostics.desktopShell` | [desktop-shell.md](./desktop-shell.md)、[ipc-channels.md](./ipc-channels.md) |
| 启动链路可解释 | Tauri Rust 记录 `channel-env-applied -> resource-preflight -> server-script-resolved -> node-binary-resolved -> web-server-spawned -> health-ready -> window-navigated`，失败时写短原因和前次失败记录 | [desktop-shell.md](./desktop-shell.md)、[observability.md](./observability.md) |
| Bundle 资源完整性 | 包内启动前检查 `dist/web/webServer.cjs`（1.2KB launcher，启用 V8 compile cache 后加载 `webServer.bundle.cjs` payload）、`dist/renderer/index.html`、bundled Node 和 `better-sqlite3` native module；本地 package / release bundle 脚本都挂 `verify:webserver-boot`（must-bundle 库检查对象为 payload） | [desktop-shell.md](./desktop-shell.md)、[hot-update.md](./hot-update.md) |
| Renderer 与 shell 版本合同 | `/api/health.rendererServe` 暴露 active/builtin/static 来源和 `active-healthy`、`hot-update-disabled`、`no-active-meta`、`active-index-missing`、`active-older-than-shell` 等原因，避免热更覆盖旧前端 | [desktop-shell.md](./desktop-shell.md)、[hot-update.md](./hot-update.md) |
| Runtime asset registry | `system-audio-capture`、`vision-ocr`、`vision-tagger`、Computer Use app、`uv`、`rtk`、sharp runtime 和可选 browser/audio runtime 都进入统一 registry/status，带平台、版本、最小壳版本和 hash 摘要 | [desktop-shell.md](./desktop-shell.md)、[native-app-integration.md](./native-app-integration.md) |
| Native command facade | 前端组件通过 `nativeDesktop`、`nativeCommandFacade`、`tauriPluginFacade` 调 native domain API / Tauri command / plugin，不把 invoke 和插件细节散在 UI 组件里 | [desktop-shell.md](./desktop-shell.md)、[native-app-integration.md](./native-app-integration.md) |
| Release acceptance | `desktop-shell:packaged-smoke` 生成可交给 `release:post-publish` 的 JSON 证据；v0.26.1 已完成签名分发与隔离 smoke，fresh-profile 远程 capability 初始化从 HTTP/首窗关键路径移到后台 | [desktop-shell.md](./desktop-shell.md)、[hot-update.md](./hot-update.md)、[release checklist](../releases/RELEASE_CHECKLIST.md) |

## 2026-06-18 架构增量（Web Data / Release Verification / Input Surface）

今天这轮把默认联网数据层、输入区推荐密度和发版后生产验收合到同一张运行时地图，当前合同分布在 [tool-system.md](./tool-system.md)、[frontend.md](./frontend.md) 和 [hot-update.md](./hot-update.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Firecrawl 默认 web 数据层 | `WebSearch` / `WebFetch` 对公网页面优先走 Firecrawl keyless/authenticated search/scrape；本地/私网/raw data URL 仍走 native fetch；三次连续失败后短冷却并自动回退 | [tool-system.md](./tool-system.md) |
| 搜索源可发现性 | 智能路由以 Firecrawl 为基础，再按查询类型补 Perplexity/Tavily/Exa/Brave/OpenAI；已配置但本轮未用的 premium 源会给软提示，用户显式 `sources` 时不打扰 | [tool-system.md](./tool-system.md) |
| 输入区推荐降噪 | Skill 推荐最多 2 个，能力建议最多 3 个，已作为 Skill 推荐展示的能力不再重复出现；有 tool 能力的模型不再被误判为不擅长搜索 | [frontend.md](./frontend.md) |
| 非流式工具内容顺序 | OpenAI-compatible / Claude 非流式 wrapper 保留工具调用前导正文，并生成 `contentParts`，让非流式渲染和 SSE 流式路径同序 | [frontend.md](./frontend.md)、[agent-core.md](./agent-core.md) |
| 发版后生产验收 | `release:post-publish` 覆盖 app update、download redirect、landing version slot、renderer rollout、OSS manifest、`release-record.json`、rollback 状态和可选 Vercel 日志审计 | [hot-update.md](./hot-update.md) |
| 日志路径一致性 | `CODE_AGENT_LOG_DIR` 可覆盖日志目录，Tauri 壳层向 Node webServer 注入同一目录，诊断导出和运行期文件 sink 不再各找各的路径 | [hot-update.md](./hot-update.md) |

## 2026-06-17 架构增量（Iteration Governance / Ledger / Budget / Design System）

这一轮把 6 月 16~17 日的大量产品迭代收进可审计架构面，当前合同分布在 [data-storage.md](./data-storage.md)、[tool-system.md](./tool-system.md) 和 [frontend.md](./frontend.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Event ledger | 权限决策、工具执行生命周期和 Swarm 协同运行都有 append-only 事件表；ledger 写入 fail-safe，不改变主流程结果 | [data-storage.md](./data-storage.md)、[tool-system.md](./tool-system.md) |
| Swarm source of truth | `swarm_run_ledger` 成为 Swarm rollup 事实源；`swarm_runs` / `swarm_run_agents` 降级为读缓存；半套账本跳过完成态判断 | [swarm-trace-persistence.md](./swarm-trace-persistence.md) |
| Reconcile and backfill | reconcile 默认只读扫描，显式 `rebuildOnDrift` 才用 ledger 重建 rollup 缓存；老 run backfill 默认跳过，只能 opt-in | [data-storage.md](./data-storage.md)、[swarm-trace-persistence.md](./swarm-trace-persistence.md) |
| Static gates | console/a11y/stale-dist/lint 进入静态治理门；设计系统 gate 以 ratchet 基线限制新增 hex、裸 button 和手搓 modal | [frontend.md](./frontend.md)、`scripts/check-design-system.mjs` |
| Budget visibility | `BudgetService` 与 Settings/StatusBar/toast 串起来，提供预算上限、阈值、周期、告警去重和成本染色 | [frontend.md](./frontend.md)、[agent-core.md](./agent-core.md) |
| Tool result UX | 工具失败 action、auto-loaded retry 过滤、Bash 输出头尾预览、进度帧折叠和非 0 退出码提示进入统一展示层 | [tool-system.md](./tool-system.md)、[frontend.md](./frontend.md) |
| Compaction stuck guard | 连续压缩后仍超阈值时暂停 auto-compaction 并注入收窄范围提示，和总 token budget wrap-up 并存 | [agent-core.md](./agent-core.md) |

## 2026-06-12 架构增量（Agent Runtime / MiMoCode / Ops）

这一轮把竞品研究里验证过的 runtime 机制、嵌套子代理和运营面修补合并进当前架构，当前合同分布在 [agent-core.md](./agent-core.md)、[multiagent-system.md](./multiagent-system.md) 和 [native-app-integration.md](./native-app-integration.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Runtime hardening | 多级 Edit replacer、doom-loop guard、taskGate、goal impossible 止损、max-step 三段式兜底、retry 分类、abortable retry sleep、provider 失败友好提示进入主链路 | [agent-core.md](./agent-core.md) |
| Checkpoint recovery | checkpoint writer 保持后台 LLM 子代理路径；重建边界插入只短等前台窗口，超时或无明确成功结果 fail-closed 回 summary 压缩 | [agent-core.md](./agent-core.md) |
| History / memory / dream | transcript FTS 按 kind 索引工具输入输出、用户文本、assistant 文本和 reasoning；History 工具可被 deferred preload 发现；memory packing 增加 BM25；dream consolidation 以原始轨迹为证据 | [agent-core.md](./agent-core.md)、[data-storage.md](./data-storage.md) |
| Commands / skills / provider prompts | slash 命令注册表、frontmatter、自定义命令文件和 MCP prompts 入表；superpowers 方法论 skill 内置；经验蒸馏草稿拒绝低价值工具序列名；provider-family prompt variants 支持 A/B eval | [tool-system.md](./tool-system.md)、[agent-core.md](./agent-core.md) |
| Nested subagent | 默认 3 层、硬上限 5 层；整棵 spawn tree 共享并发配额、预算和超时；取消和孤儿回收按子树传播；子 agent 输出按父 agent 消费场景蒸馏 | [multiagent-system.md](./multiagent-system.md) |
| Max Mode | propose-only 并发候选 + judge 选赢家 + winner replay；候选和 judge 成本单独记账，取消/解析失败显式降级 | [agent-core.md](./agent-core.md) |
| CUA governance | CUA driver 桌面/CLI 注册链路补齐，跨会话文件锁、轨迹软停、失败分类统计进入灰度治理面 | [native-app-integration.md](./native-app-integration.md) |
| MCP self-service | 普通登录用户可添加/启停/重连 MCP server；桥接和 native connector 诊断仍只给 admin；HTTP Streamable MCP、`url` alias、headers 进入 `mcp_add_server` / `MCPUnified` | [tool-system.md](./tool-system.md) |
| Admin / renderer ops | Admin role toggle 走 Supabase `SECURITY DEFINER` RPC；active renderer bundle 低于 shell 版本时回 builtin；renderer 生产 verifier 有 metadata/bundle timeout；会话日志导出失败会打开 runtime logs 兜底 | [data-storage.md](./data-storage.md)、[hot-update.md](./hot-update.md) |

## 2026-06-05 架构增量（对话式角色 / 会话自动化 / 设置保存语义）

这一轮的主线是把聊天入口里的长期任务和角色资产变成显式可确认的产品链路，同时修正模型设置页的默认模型写入边界。当前合同分布在 [agent-core.md](./agent-core.md) 和 [frontend.md](./frontend.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| `/schedule` 模板创建 | `/schedule` 空参打开 `ScheduleComposerCard`，模板只生成自然语言描述，仍复用 `cron:generateFromPrompt -> createJob`；一次性 `at` 任务必须是未来时间 | [frontend.md](./frontend.md)、[ipc-channels.md](./ipc-channels.md) |
| `/loop` 后台化 | `LoopController` 继续在当前主进程内存跑，但把运行、进度、终态镜像到 `BackgroundTaskLedger`；自然完成/失败发台账通知和系统通知 | [agent-core.md](./agent-core.md)、[frontend.md](./frontend.md) |
| loop meta turns | loop 自动轮次走 `historyVisibility: 'meta'`，消息、事件和 SQLite 带 `isMeta`；会话列表、FTS、同步和 summary 过滤 meta 与 loop marker | [agent-core.md](./agent-core.md)、[data-storage.md](./data-storage.md) |
| 系统通知投递 | main 负责记录和广播通知，renderer 用 Tauri notification plugin 投递；`domain:notification/getRecent` 是只读诊断口 | [ipc-channels.md](./ipc-channels.md)、[frontend.md](./frontend.md) |
| 对话式角色创建/修改 | `create-role` / `edit-role` skill 通过 slash seed 触发，`propose_role` 只入队草稿，`RoleDraftCard` 用户确认后才写 `agents/<roleId>.md` | [agent-core.md](./agent-core.md)、[frontend.md](./frontend.md)、[data-storage.md](./data-storage.md) |
| strict skill toolset | `strictToolset` 只对 opt-in skill 收缩模型可见工具，防止 role authoring 绕过确认卡；active skill allowedTools 会驱动 deferred 工具预加载 | [agent-core.md](./agent-core.md) |
| 模型设置保存 | 保存 provider 只写连接和 provider config；显式「设为默认」才写默认模型字段 | [frontend.md](./frontend.md) |

## 2026-05-29~31 架构增量（Dynamic Workflow / Runtime Consolidation）

这一轮的主线是把复杂多 Agent 编排、模型运行时控制、真实 app-host 验收和旧入口删除收成同一张运行时地图。详细快照和验收合同见 [Runtime Consolidation 2026-05-31](./runtime-consolidation-2026-05-31.md)。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Dynamic Workflow | `workflow` 工具让模型写 JS 编排脚本，在 worker 沙箱中用 `agent / parallel / pipeline / phase / log / budget` 执行；支持跑前审批、进度树、token budget、provider-aware 并发闸和显式 resume | [dynamic-workflow.md](./dynamic-workflow.md) |
| Provider 运行时控制 | Model Settings 增加 per-provider `maxConcurrent` 和 `proxyMode`；ConfigService 保存后热更新 limiter/proxy override；workflow runtime 读取 provider cap 做全局公平分配 | [runtime-consolidation-2026-05-31.md](./runtime-consolidation-2026-05-31.md) |
| App-host runtime smoke | pause/resume、UI cancel、tool cancel、session persistence、manual compact、Agent Team、real-agent replay/eval 进入固定验收矩阵 | [Runtime Consolidation 2026-05-31](./runtime-consolidation-2026-05-31.md) |
| Fleet Observability | Sentry、Supabase telemetry、PostHog dashboard 和 admin-console errors/feedback/session detail 形成分发用户观测链路 | [observability.md](./observability.md) |
| 旧入口删除 | legacy generation shell、MasterTask remnants、dead worker/teamManager、scenario AcceptanceRunner、TaskPanel ConnectorsCard、decorator tool framework 等下线，当前归属写入运行时收口快照 | [Runtime Consolidation 2026-05-31](./runtime-consolidation-2026-05-31.md) |

## 2026-05-15~17 架构增量（Agent Neo / 管理面 / 外部 Agent Engine / In-App 验证）

这一轮的主线是把 Agent Neo 的产品壳、配置面、外部 agent 接力和交付验证接到现有 runtime 上。它复用 ConversationRuntime、ToolExecutor、TaskPanel、Settings 和 Capability Center，没有新建第二套 agent loop。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Agent Neo 品牌层 | Tauri app、icon、Info.plist、MCP server、About/Update、终端输出和 landing page 切到 Agent Neo；仓库名仍为 code-agent | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| 本地模型配置 | server-side cloud proxy 已删除；首次使用走模型配置 onboarding，本机 Provider API Key 进入 `ModelSettings` 与 provider wrappers | [cloud-architecture.md](./cloud-architecture.md) |
| Agent Engine | Native Agent Neo、Codex CLI、Claude Code 共享 `AgentEngineSessionMetadata`；外部 engine 只允许 read-only、workspace-only、manual chat session，输出进 task ledger | [agent-core.md](./agent-core.md) |
| Capability Center | 本地 registry 汇总 skill、MCP template、tool bundle、channel adapter、workflow recipe、connector、agent engine；MCP 安装先落 disabled draft | [plugin-system.md](./plugin-system.md) |
| 记忆管理 | Memory import、entry runtime、knowledge inbox、injection trace、seed injector 与 Settings Memory / Knowledge Memory Panel 打通 | [data-storage.md](./data-storage.md) |
| In-App HTML Validation | `validate_html_in_app` 工具通过 main↔renderer IPC 打开右侧 iframe 面板，复用 BrowserInteraction DSL 执行交互断言 | [tool-system.md](./tool-system.md) |
| Managed Browser Surface | Browser relay extension 和 `BrowserSurfacePanel` 让托管浏览器状态进入右侧工作面，和 BrowserService 保持同一 session 语义 | [workbench.md](./workbench.md) |
| Background Task Ledger | shell、PTY、外部 engine 使用统一 Task 合同，TaskStatusBar/TaskPanel 可读完成通知、失败原因和 output refs | [frontend.md](./frontend.md) |
| Artifact repair Route A | repair 先走 full rewrite，再继承 baseline/failures，monotonic gate 约束修复轮次 | [artifact-verification.md](./artifact-verification.md) |
| Settings / Admin | Workspace、Automation、Data、Model、Capability、用户 dashboard、邀请码与更新页进入设置；admin-only IPC 走统一 guard | [data-storage.md](./data-storage.md) |
| Release security gate | renderer/web sourcemap 默认关闭，Tauri resources 不打包 webServer map，出包和安装前跑 inventory/security scan | [hot-update.md](./hot-update.md) |

## 2026-05-13~14 架构增量（Context Health 溯源 / 取消级联 / Computer-use MCP 入口归位 / 工作台面板群）

这一轮把上下文 token 的来源可观测性、多 agent 取消的级联语义、Computer/Screenshot 的 MCP 入口归位，以及一批聊天主链路诊断面板收进主产品面。架构上复用既有 `ContextHealthService`、`subagentExecutor`、native ToolModule registry 和 workbench 面板体系，没有引入新的并行运行时。

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Context Health Token 溯源 | `TokenBreakdown.bySource` 新增 rules/skills/mcp/subagents/fileReads/conversation 六维；`ContextHealthService.recordSourceContribution` 在 skill mount/unmount、AGENTS.md 注入、fileRead、MCP 结果、subagent 输出时上报，200ms 防抖广播；renderer `ContextPanel`（workbench context tab）+ `ContextHealthPanel` 二级展开，✕ 卸载真实接 `setServerEnabled` IPC，跳转联动 SkillsPanel highlight | [agent-core.md](./agent-core.md) |
| 取消级联 | `CancellationReason` 区分 CASCADE（user-cancel / session-switch / parent-cancel）与 NON_CASCADE（child-error / timeout / idle-timeout / budget-exceeded）；`initiateShutdown` 四阶段 Signal→Grace→Flush→Force；idle watchdog 2 分钟无进展自动 abort；per-agent Stop UI + `swarm:cancel-agent` IPC；spawnGuard ↔ parent abortSignal 单向桥接 | [multiagent-system.md](./multiagent-system.md) |
| Computer-use MCP 入口归位（Level 1） | Computer + Screenshot 暴露成独立 native ToolModule，统一走 MCP 工具入口；当前是 wrapper-mode，执行仍委托 legacy ComputerTool，并通过 `adaptVisionLegacyResult` 适配结果；Level 2 原生重写后再替换执行内核 | [tool-system.md](./tool-system.md) |
| Workbench 诊断面板群 | Context Health、Knowledge Memory Audit、Activity Entry、Computer-use Diagnostics、Time Capability 五类诊断面板进入聊天主链路工作台；Workspace Preview 露出活动与工作区产物 | [workbench.md](./workbench.md) |
| Runtime Steer | 运行中途用户输入通过 `injectSteerMessage` 排队到当前轮次消息历史，置 `needsReinference` 下轮推理；guided UI 用 `RuntimeInputDelivery` 标记 `queued_next_turn`；web host follow-up 带 `clientMessageId` | [agent-core.md](./agent-core.md) |
| Vision 模型切换 | `ZHIPU_VISION_MODEL` 切到免费档 `glm-4.1v-thinking-flash`（带推理链），8 个视觉模块统一从常量读取 | — |
| Channel / 本地活动隐私防火墙 | 渠道入站消息与本地桌面活动落地前统一脱敏：`channelPrivacyFirewall` 三模式（local-redact/allow-raw/off）+ 飞书接入，`localActivityPrivacyFirewall` + `screenshotPrivacyRedactor` 截图区域级 blur，`sensitiveDataGuard` 补 SSN / 信用卡 Luhn 脱敏，`native_desktop.rs` Rust 侧对称脱敏 | [sensitive-data-guard.md](./sensitive-data-guard.md) |

## 2026-05 当前架构增量

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Native ToolModule registry | `src/host/tools/registry.ts` 三段式 schema/loader/handler registry；`modules/index.ts` 注册 108 个 native ToolModule；旧 wrapper 只保留兼容 | [tool-system.md](./tool-system.md) |
| Runtime / Context hardening | CompactionService + SurvivorManifest + audit/validation/hooks；partial-failure trace、Web session recovery、assistant persistence、failure-mode loop breaker | [agent-core.md](./agent-core.md) |
| Artifact quality gate | Game/Deck/Dashboard verifier 和 repair guard 产出真实证据；产品级质量问题进入 `ArtifactIssue`、`EvalReplayQualityReport` 和 Admin Review Queue；旧 AcceptanceRunner / Delivery Review / Preview Feedback 已下线 | [artifact-verification.md](./artifact-verification.md) |
| Browser / Computer multi-agent isolation | BrowserService pool、ephemeral launch semaphore、ComputerSurface write lock、targetApp screenshot crop | [multiagent-system.md](./multiagent-system.md) |
| Custom Agent registry | `~/.code-agent/agents/*.md` 与 `<cwd>/.code-agent/agents/*.md` 进入 `agentRegistry` 单一来源；project > user > builtin；CLI / spawn / @mention / StatusBar 共用同一列表 | [multiagent-system.md](./multiagent-system.md) |
| Subagent permission inheritance | `strict-inherit` 默认；parentContext、用户 deny/ask/allow、readonly→writer 禁止派生进入 subagent 运行时 | [multiagent-system.md](./multiagent-system.md) |
| Doctor diagnostics | `/doctor` 聚合 9 categories / 24 items，CLI 和 GUI 共享 `DoctorReport`；MCP lazy 计 skip，网络/版本失败降级 warn | [cli.md](./cli.md) |
| Frontend execution rails | Chat 顶部 Run Status Rail、TaskPanel task-first rail、Workspace Preview artifact review workbench | [frontend.md](./frontend.md) |
| Typed IPC / provider wrappers | `defineHandler` + zod schemas + renderer typedInvoke；provider response/SSE wrappers 与 provider symmetry guard | [ipc-channels.md](./ipc-channels.md) |
| Cloud task retirement | 旧 cloud agent / orchestrator / POC cloud tools 已退役；当前保留 cloud config、update、feature flag、cloud proxy 等服务 | [cloud-architecture.md](./cloud-architecture.md) |

## 2026-04-27 当前架构增量

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Agent run lifecycle | `ConversationRuntime` 统一 terminal path，failure/cancel/interrupted 都经 `RunFinalizer`；`agent_cancelled` 不再伪装成 complete | [agent-core.md](./agent-core.md) |
| TaskManager-owned chat run | `AgentAppService.sendMessage` 走 TaskManager-owned send，pause/resume/cancel/interrupt 尽量对齐同一个 run owner | [agent-core.md](./agent-core.md) |
| Tool/MCP 权限合同 | ToolExecutor 顶层审批结果向 resolver 传递，MCP dynamic tool 可 direct execute，ToolSearch 对不可调用项返回 `loadable:false` 和原因 | [tool-system.md](./tool-system.md) |
| Durable runtime state | todos、session tasks、context interventions、compression state、persistent system context、pending approvals 按 session 落 SQLite | [data-storage.md](./data-storage.md) |
| Multiagent reliability | parallel inbox、success-only dependency gate、failed/blocked/cancelled aggregation、run-level cancel 已有定向测试 | [multiagent-system.md](./multiagent-system.md) |
| Replay / eval completeness | structured replay 关联 model/tool/event evidence；`real-agent-run` eval gate 校验 `telemetryCompleteness` | [agent-core.md](./agent-core.md) |

## 2026-04-26 当前架构增量

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Workbench B+ | ChatInput 保留高频发送动作，低频动作收进 `+`；Routing / Browser 归到 Settings “对话”tab；TitleBar 瘦身，全局页面入口进入 Sidebar User Menu | [workbench.md](./workbench.md) |
| Live Preview V2 | Vite-only MVP：devServerManager + DevServerLauncher + click-to-source + protocol 0.3.0 + TweakPanel；Next.js App Router 支持按 ADR-012 延期 | ADR-012 索引见 [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Browser / Computer Workbench | in-app managed browser 具备 session/profile/account/artifact/lease/proxy/TargetRef；Computer Surface 具备 background AX / CGEvent 受控验证路径 | [Native App 集成](./native-app-integration.md) |
| Activity Providers | OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 统一输出 `ActivityContext`，由 prompt formatter 控制注入 | [activity-providers.md](./activity-providers.md) |
| Semantic Tool UI | `_meta.shortDescription` 从 prompt/schema/provider/parser 到 ToolCall UI 打通，弱模型缺失时有 fallback generator；Memory citation / diff summary / URL chip 进入聊天展示层 | [workbench.md](./workbench.md) |

## 分层架构

| 层级 | 职责 | 详细文档 |
|------|------|----------|
| Presentation | UI 组件、状态管理、Generative UI、用户交互 | [frontend.md](./frontend.md) |
| Application | Agent 编排、平台抽象、Light Memory、Skills 系统 | [agent-core.md](./agent-core.md) |
| Tool | 108 个 native ToolModule（9 类），Core/Deferred 双层、统一入口 | [tool-system.md](./tool-system.md) |
| Data | 本地存储、云端同步 | [data-storage.md](./data-storage.md) |
| Cloud / Sync | cloud task 历史归档；当前保留同步、更新、feature flag、cloud proxy 服务 | [cloud-architecture.md](./cloud-architecture.md) |

## 平台抽象层

`src/host/platform/` 是连接前后端的关键层，统一替代所有直接 Electron 导入：

| 模块 | 文件 | 职责 |
|------|------|------|
| App 路径 | `appPaths.ts` | 统一的应用路径和生命周期 API |
| IPC 注册 | `ipcRegistry.ts` | Handler 注册中心，跨平台 IPC 抽象 |
| Window 桥接 | `windowBridge.ts` | 渲染进程通信（broadcastToRenderer） |
| Native Shell | `nativeShell.ts` | 打开外部链接、文件 |
| 剪贴板 | `nativeClipboard.ts` | 读写剪贴板 |
| 通知/快捷键 | `notifications.ts` / `globalShortcuts.ts` | 系统级交互 |
| 兼容层 | `miscCompat.ts` | dialog, Tray, Menu 等 Electron API 兼容 |

所有业务代码通过 `import { ... } from '../platform'` 引入，不直接依赖 Electron 或 Tauri API。

## 新增子系统（v0.16.52+）

| 子系统 | 位置 | 说明 |
|--------|------|------|
| **Light Memory** | `src/host/lightMemory/` | File-as-Memory，~700 行代码替代旧 13K+ 行 vector/embedding 系统。6 层上下文注入 |
| **Generative UI** | renderer `MessageBubble/` | ChartBlock（6 种 Recharts 图表）+ GenerativeUIBlock（沙箱 iframe HTML 小程序） |
| **Combo Skills** | `src/host/skills/` | 用户可定义技能，关键词自动匹配 |
| **System Tray** | platform `miscCompat.ts` → Tray | 系统托盘集成 |
| **Desktop Vision** | `desktopVisionAnalyzer.ts` + Rust FFI | 后台截图 + 视觉模型语义描述（Ollama 本地 / 智谱云端） |
| **Cron Center** | renderer `features/cron/` | 定时任务管理面板 |
| **Activity Providers** | `src/host/services/activity/` + `src/shared/contract/activity*.ts` | 统一 OpenChronicle / Tauri Native Desktop / audio / screenshot-analysis 的上下文来源和注入边界 |
| **Live Preview V2** | `src/host/services/infra/devServerManager.ts` + `src/renderer/components/LivePreview/` | 自动启动本地 dev server、iframe source grounding、TweakPanel 原子样式编辑 |
| **Browser / Computer Workbench** | `src/host/services/infra/browserService.ts` + `browserPool.ts` + `src/host/services/desktop/` | 托管浏览器会话、per-agent 隔离、TargetRef、artifact、Computer Surface 安全动作面 |
| **Artifact Quality Gate** | `src/host/agent/runtime/{game,deck,dashboard}/` + `src/host/agent/runtime/repair/` + `src/shared/contract/productClosure.ts` + `ArtifactIssueRepository` | kind-specific 验收、真实证据采集、artifact issue、replay quality report、admin review queue |
| **Context Health 溯源** | `src/host/context/contextHealthService.ts` + `src/shared/contract/contextHealth.ts` + renderer `ContextPanel/ContextHealthPanel` | `TokenBreakdown.bySource` 六维来源溯源（rules/skills/mcp/subagents/fileReads/conversation），workbench context tab 二级展开，✕ 卸载接 `setServerEnabled` IPC |
| **取消级联 / Shutdown Protocol** | `src/shared/contract/cancellation.ts` + `src/host/agent/shutdownProtocol.ts` + `src/host/agent/subagentExecutor.ts` | `CancellationReason` 区分 CASCADE/NON_CASCADE，四阶段 shutdown，idle watchdog，per-agent Stop UI |
| **Agent Engine Adapters** | `src/shared/contract/agentEngine.ts` + `src/host/services/agentEngine/` + `src/host/ipc/agentEngine.ipc.ts` | Native / Codex CLI / Claude Code engine 元数据、检测、read-only 执行、历史导入和 task ledger 回带 |
| **Capability Center** | `src/shared/contract/capability.ts` + `src/host/services/capabilities/` + `docs/capabilities/` | 本地能力货架，覆盖 skill、MCP template、workflow recipe、connector、agent engine，MCP draft 默认 disabled |
| **In-App HTML Validation** | `src/shared/contract/browserInteraction.ts` + `src/host/tools/modules/vision/validateHtmlInApp.ts` + `InAppValidationPanel.tsx` | HTML artifact 在 app 内 iframe 中运行交互脚本和 expect 断言，形成用户可见的验证轨迹 |
| **Admin / Invite Management** | `src/host/ipc/adminGuard.ts` + `src/host/services/admin/` + `supabase/migrations/20260516000000_user_invite_management.sql` | 管理员用户 dashboard、邀请码管理、RLS/RPC admin guard |
| **Conversation Automation Cards** | `ScheduleComposerCard` + `scheduleTemplates` + `LoopStatusBar` + `TaskStatusBar` | `/schedule` 空参模板创建，`/loop` 后台任务状态进入主聊天和 task rail |
| **Role Authoring Drafts** | `roleDraftQueue` + `propose_role` + `RoleDraftCard` + `create-role/edit-role` builtin skills | 对话式创建/修改持久化角色，草稿隔离，用户确认后落盘 |
| **Notification Delivery Bridge** | `notificationService` + `notification.ipc.ts` + `osNotification.ts` | 主进程记录通知，renderer 负责原生投递和投递结果回报 |

## 工具体系（108+ 个 native ToolModule）

15 个核心工具始终发送给模型，其余通过 ToolSearch 按需加载。当前 native registry 以 108 个 ToolModule 为基线，2026-06-05 角色创作分支新增 deferred native 工具 `propose_role`。按功能分为 9 类：

| 分类 | 代表工具 |
|------|----------|
| Shell & 文件 | Bash, Read, Write, Edit, MultiEdit, Glob, Grep, GitCommit |
| 规划 & 任务 | TaskManager, Plan, PlanMode, AskUserQuestion, confirm_action, findings_write |
| Web & 搜索 | WebSearch, WebFetch, ReadDocument, LSP, Diagnostics |
| 文档 & 媒体 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart |
| 外部服务连接器 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | Computer, Browser, GuiAgent, visual_edit, Live Preview IPC |
| 多 Agent | AgentSpawn, AgentMessage, WaitAgent, SendInput, CloseAgent, Teammate |
| 统一入口 + 元工具 | Process, MCPUnified, DocEdit, ToolSearch |

> **统一入口**：细粒度工具通过 action 参数合并（如 ReadDocument 合并 read_pdf/read_docx/read_xlsx）。
>
> **DocEdit**：自动识别格式（.xlsx/.pptx/.docx）路由到对应编辑引擎，原子操作替代全量重写。

## 相关文档

- [Agent 核心](./agent-core.md) - AgentLoop、消息流、规划系统
- [工具系统](./tool-system.md) - 工具注册、执行、分类
- [前端架构](./frontend.md) - React 组件、状态管理
- [数据存储](./data-storage.md) - SQLite、Supabase、向量数据库
- [云端/同步历史架构](./cloud-architecture.md) - 旧 cloud task 归档与当前 cloud config/update/feature flag 服务边界
- [架构决策记录](./decisions/) - 当前独立 ADR 文档；历史 ADR 索引见 [ARCHITECTURE.md](../ARCHITECTURE.md)
