# Agent Neo / Code Agent - 架构设计文档

> 版本: 9.13 (对应 v0.16.88 + AI SDK 全量迁移收口 / Light Memory 质量闭环 / MCP 只读安全边界 / Alma 式渲染；接 v0.16.80 Goal Mode 三层闸 / Appshots / OS 沙箱)
> 日期: 2026-05-26
> 作者: Lin Chen

本文档是 Agent Neo（代码仓库仍名为 Code Agent）的**架构索引入口**。详细设计已拆分为模块化文档，本文提供导航、快速参考和版本演进概要。

---

## 文档导航

### 核心架构

| 文档 | 描述 |
|------|------|
| [系统概览](./architecture/overview.md) | 整体架构图、技术栈、分层设计 |
| [Agent 核心](./architecture/agent-core.md) | AgentLoop、运行时状态机、run-level abort、TaskManager-owned chat send、ContextAssembly |
| [工具系统](./architecture/tool-system.md) | ToolRegistry、ToolExecutor、Core/Deferred、MCP dynamic tools、权限合同 |
| [前端架构](./architecture/frontend.md) | React 组件、Zustand 状态、useAgent Hook |
| [数据存储](./architecture/data-storage.md) | SQLite、Supabase、session runtime state、telemetry/replay、SecureStorage |
| [云端/同步历史架构](./architecture/cloud-architecture.md) | 历史 cloud task / orchestrator 设计归档；当前保留配置、更新、feature flag、cloud proxy 等服务 |
| [多 Agent 编排](./architecture/multiagent-system.md) | Agent Team 并行执行、parallel inbox、dependsOn gate、run-level cancel、SpawnGuard |
| [Dynamic Workflow](./architecture/dynamic-workflow.md) | 命令式脚本编排运行时：模型写 JS 脚本 → worker 沙箱后台执行、5 原语、forced 结构化、provider-aware 并发闸、token budget、跑前审批、resumable |
| [Chat-Native Workbench](./architecture/workbench.md) | 聊天主链路能力工作台（ConversationEnvelope + InlineWorkbenchBar + Turn Timeline + Prompt Rewind），与 TaskPanel(sidecar) 分工 |
| [Artifact Verification](./architecture/artifact-verification.md) | AcceptanceRunner、Game/Deck/Dashboard verifier、Delivery Review、Preview Feedback |
| [Activity Providers](./architecture/activity-providers.md) | OpenChronicle / Tauri Native Desktop / audio / screenshot-analysis 统一上下文 provider 边界 |
| [Native App 集成](./architecture/native-app-integration.md) | Skill / Tool / Service / Connector / MCP 边界与调用链路；为什么 macOS 原生应用走 connector 不走 MCP |
| [CLI 架构](./architecture/cli.md) | 5 种运行模式、CLIAgent 适配层、输出格式化、命令系统 |

### 架构决策记录 (ADR)

| ADR | 标题 | 状态 |
|-----|------|------|
| [001](./decisions/001-turn-based-messaging.md) | Turn-Based 消息流架构 | accepted |
| [002](./decisions/002-eight-generation-tool-evolution.md) | ~~8 代工具演进策略~~ | superseded |
| [003](./decisions/003-cloud-local-hybrid-architecture.md) | 云端-本地混合执行架构 | accepted |
| [004](./decisions/004-unified-plugin-config-structure.md) | 统一插件配置目录结构 | proposed |
| [005](./decisions/005-eval-engineering.md) | Eval Engineering Key Decisions | accepted |
| [006](./decisions/006-deferred-tools-consolidation.md) | Deferred Tools 合并精简 (Phase 2) | accepted |
| [007](./decisions/007-protocol-migration-reality-check.md) | Protocol 迁移现实性复盘 | accepted |
| [008](./decisions/008-swarm-actor-refactor.md) | Swarm Actor 重构 | accepted |
| [009](./decisions/009-dual-coordinator-split.md) | 双 Coordinator 拆分 | accepted |
| [010](./decisions/010-swarm-road-to-10.md) | Swarm Road to 10 | closed |
| [011](./decisions/011-chat-native-workbench.md) | Chat-Native Workbench 架构 | accepted |
| [012](./decisions/012-live-preview-v2-c-deferred.md) | Live Preview V2-C Next.js 支持延期，V2 收敛为 Vite-only MVP | accepted |
| [013](./decisions/013-local-model-eval-support.md) | 评测中心 + 主聊天支持本地 Ollama 模型 | accepted |
| [014](./decisions/014-debug-snapshot-system.md) | 调试快照系统 + CLI debug 命令树 | accepted |
| [015](./decisions/015-swebench-docker-eval-harness.md) | SWE-bench docker-based eval harness | accepted |
| [016](./decisions/016-no-cross-kind-verifier-interface.md) | 不提前抽 cross-kind verifier interface | accepted |

---

## 快速参考

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Tauri 2.x (Rust) |
| Tauri 插件 | `plugin-updater` (自动更新) + `plugin-opener` (Finder reveal/open) + `plugin-dialog` (原生文件选择器) |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 构建 | esbuild (main) + Vite (renderer) |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | 小米 MiMo v2.5 Pro（默认）/ GPT-5.5 / DeepSeek V4 / Kimi K2.6 / 智谱 / 火山引擎 / Local-Ollama 多 provider 目录（14+ provider），本地 API Key 优先；显式模型只在 `adaptive=true` 时允许跨 provider fallback |
| Agent Engine | Native Agent Neo / Codex CLI / Claude Code，签名模型目录、session engine metadata、read-only 外部执行和 task ledger 回带 |
| 本地桥接 | packages/bridge (localhost:9527) |
| 代码编辑 | CodeMirror 6 (Preview 代码/Markdown 编辑模式) |

### 目录结构

```
code-agent/
├── docs/
│   ├── ARCHITECTURE.md          # 本文档（索引）
│   ├── PRD.md                   # 产品需求文档
│   ├── architecture/            # 详细架构文档
│   │   ├── overview.md          # 系统概览
│   │   ├── agent-core.md        # Agent 核心
│   │   ├── tool-system.md       # 工具系统
│   │   ├── frontend.md          # 前端架构
│   │   ├── data-storage.md      # 数据存储
│   │   └── cloud-architecture.md # 云端架构
│   └── decisions/               # 架构决策记录
│
├── src/
│   ├── main/                    # 后端主进程 (Node.js, Tauri sidecar)
│   │   │
│   │   │── ── 工程层 core ─────────────────────────
│   │   ├── app/                # 应用启动引导（bootstrap、窗口管理、生命周期）
│   │   ├── agent/              # AgentOrchestrator, AgentLoop, 多 Agent 协作
│   │   ├── context/            # 上下文投影系统（6 层压缩管线 + CompressionState + ProjectionEngine）
│   │   ├── errors/             # 统一错误处理（分类、恢复引擎、自动学习）
│   │   ├── events/             # 事件三通道（InternalEventStore 持久化 + ControlStream 实时 + Mailbox 协调）
│   │   │                         # 注：EventBus / EventBridge 运行时已迁出 protocol/，归位到 services/eventing/
│   │   ├── hooks/              # 用户可配置钩子系统（Agent Hook + 内置 Hook + trigger history）
│   │   ├── ipc/                # IPC handler 层（前后端通信桥梁，含 provider.ipc.ts 连通性测试+诊断+健康状态）
│   │   ├── model/              # ModelRouter, Provider, 自适应路由, 智能 Fallback, HealthMonitor, 请求规范化中间件
│   │   ├── permissions/        # 权限矩阵（GuardFabric 多源竞争 + PolicyEngine + 拓扑感知）
│   │   ├── platform/           # 平台抽象层（Tauri/Electron/Web 差异封装）
│   │   ├── prompts/            # Prompt 矩阵（4 Profile × 5 层 Overlay + Prompt Registry/override + 缓存稳定性）
│   │   ├── routing/            # Agent 路由系统（意图分类 + 路由决策）
│   │   ├── security/           # 运行时安全（命令监控、敏感信息检测、审计日志）
│   │   ├── services/           # 核心服务（Auth, Admin, AgentEngine, CapabilityCenter, Sync, Database, SecureStorage, cloud config/update/feature flag）
│   │   ├── session/            # 会话管理（Worker Epoch 生成代围栏、快照重物化、导出、分叉、恢复）
│   │   ├── tools/              # gen1-gen8 工具实现 + DocEdit
│   │   │                         # 注：tool dispatch 已从 protocol/ 拆出，归位到 tools/dispatch/（M1.2）
│   │   │
│   │   │── ── 智能层 ──────────────────────────────
│   │   ├── cron/               # 定时任务与心跳监控
│   │   ├── evaluation/         # 回放/遥测/实验跟踪基础设施（v0.16.79 删评测双管道死代码）
│   │   ├── desktop/            # 桌面活动服务（从旧 memory/ 搬迁）
│   │   ├── lightMemory/        # Light Memory 系统（File-as-Memory, ~700 行，唯一记忆系统）
│   │   ├── planning/           # 规划系统
│   │   ├── research/           # 深度研究模式（多源路由、自适应搜索、报告生成）
│   │   ├── scheduler/          # DAG 并行任务调度
│   │   ├── task/               # 多任务并行管理（TaskManager + Semaphore 信号量）
│   │   ├── telemetry/          # 遥测采集（意图分类统计、Prompt 缓存、存储）
│   │   ├── testing/            # Agent 自动测试框架（YAML 用例 + 断言引擎 + CI）
│   │   │
│   │   │── ── 技能层 ──────────────────────────────
│   │   ├── channels/           # 多渠道接入（飞书 Webhook 等）
│   │   ├── connectors/         # Office 连接器（日历、邮件、提醒事项，macOS 原生）
│   │   ├── mcp/                # MCP 服务端/客户端
│   │   ├── plugins/            # 插件系统（PluginAPI v2 + 7 个 builtin plugins + 第三方加载）
│   │   ├── skills/             # 用户可定义技能 + 数据清洗 Skill
│   │   │
│   │   │── ── 基础设施 ────────────────────────────
│   │   ├── config/             # 统一配置（路径管理、规则加载）
│   │   ├── cron/               # 定时任务与心跳监控（CronService + Heartbeat）
│   │   ├── ide/                # IDE 桥接接口（未来 IDE 集成预留）
│   │   ├── lsp/                # LSP 语言服务器协议（多语言 Server 管理）
│   │   ├── scheduler/          # DAG 并行任务调度
│   │   ├── types/              # 主进程内部类型定义
│   │   └── utils/              # 工具函数（加密、图片处理、日志脱敏、性能计量）
│   │
│   ├── renderer/               # React 前端
│   │   ├── components/         # UI 组件（Chat, Explorer, AgentTeam, Settings...）
│   │   ├── stores/             # Zustand 状态
│   │   └── hooks/              # 自定义 hooks
│   │
│   ├── shared/                 # 类型定义、常量、IPC 协议（含 contract/designBrief、contract/workspacePreview、prompt rewind DTO）
│   ├── design/                 # Design Brief 工作流：direction-tokens、critique judge（5 维评分 + prompt）
│   ├── artifacts/              # Session-level artifact 定义（question-form 等结构化采集产物）
│   ├── shared/ipc/             # zod IPC schemas、typedInvoke / defineHandler 共享契约
│   ├── cli/                    # CLI 接口（独立构建入口；含 `debug` 命令树）
│   └── web/                    # Web Server（SSE API + 路由）
│
├── src-tauri/                   # Tauri Rust Shell
├── packages/
│   ├── bridge/                  # Local Bridge 服务 (localhost:9527)
│   └── eval-harness/            # 评测 Harness
├── vercel-api/                  # 云端 API (Vercel)
└── supabase/                    # 数据库迁移
```

### 工具体系（108 个 native ToolModule）

按功能分为 9 类，其中 15 个核心工具始终发送给模型，其余通过 ToolSearch 按需加载。2026-05 native migration 后，`src/main/tools/registry.ts` 当前注册 108 个 ToolModule，`src/main/tools/modules/` 下有 108 个 schema 文件；下表按能力域说明，不把每类数量写成长期不变量。

| 分类 | 代表工具 |
|------|----------|
| Shell & 文件 | Bash, Read, Write, Edit, MultiEdit, Glob, Grep, GitCommit, NotebookEdit |
| 规划 & 任务 | TaskManager, Plan, PlanMode, AskUserQuestion, Task, findings_write, confirm_action |
| Web & 搜索 | WebSearch, WebFetch, ReadDocument, LSP, Diagnostics |
| 文档 & 媒体 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart/QRCode, Speech |
| 外部服务连接器 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | Computer, Browser, Screenshot, GuiAgent, visual_edit |
| 多 Agent | AgentSpawn, AgentMessage, WaitAgent, CloseAgent, SendInput, Teammate |
| 统一入口 / 元工具 | Process, MCPUnified, DocEdit, ExcelAutomate, PdfAutomate, ToolSearch |

> **工具合并**: 31 个独立延迟工具合并为统一工具（Process, MCPUnified, TaskManager 等），使用 action 参数分发。详见 [ADR-006](./decisions/006-deferred-tools-consolidation.md)。
>
> **文档编辑统一**: DocEdit 统一入口，富文档为原子级增量编辑（Excel 14 操作 / PPT 8 操作 / Word 7 操作），SnapshotManager 提供快照回滚。

### 2026-05-19 Marvis 能力对照补齐：场景化 skill + Vision Framework 工具栈 + Photos connector

这一轮以"对照 Marvis (marvis.qq.com) 八大场景补齐能力广度"为驱动，分发零额外配置走完整链路。架构重点：把 macOS 原生能力（Vision Framework / Photos.app）当作 Agent Neo 的一等公民通过 connector + native binary 接入，**不走 MCP**；同时让 `visionAnalysisService` 终于摆脱硬编码智谱，自动走用户已配的 vision-capable 主 LLM。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| 场景化 builtin skill 扩展 | `BUILTIN_SKILLS` 数组追加 9 个 builtin skill（含触发词中文 description）：`computer-housekeeper`（系统清理/网络修复）、`contract-review`（10 维度风险点）、`literature-review`、`paper-distillation`（带页码定位）、`research-monitor`（cron + 飞书推送）、`image-ocr-search`、`data-analysis-helper`、`meeting-summary`、`photo-archive`；编译进 binary 所有用户开箱即用 | `src/main/services/skills/builtinSkills.ts` |
| Capability Center 对外展示 | `docs/capabilities/local-curated-registry.json` 新增 9 个 `workflow_recipe` 卡片对应上述 builtin skill；每张卡片 `audit.notes` 标注对应的 skill name；`source.contentHash` 重算（sha256:4d515295...） | `docs/capabilities/local-curated-registry.json` |
| vision-ocr Swift 工具 | macOS Vision Framework `VNRecognizeTextRequest` 中英文 OCR，零配置零云端；CLI `--photo <path> [--languages zh-Hans,zh-Hant,en-US]`，输出 JSON 含 fullText + regions（boundingBox 转左上原点像素坐标）；体积 95KB | `scripts/vision-ocr.swift`、`scripts/build-vision-ocr.sh` |
| vision-tagger Swift 工具 | `VNDetectFaceRectanglesRequest` + `VNGenerateImageFeaturePrintRequest`（人脸特征向量 base64）+ `VNClassifyImageRequest`（ImageNet 1000 类）；CLI `--mode face\|classify\|all`；体积 116KB | `scripts/vision-tagger.swift`、`scripts/build-vision-tagger.sh` |
| `ocr_search` native tool | spawn `vision-ocr` binary，OCR 结果入 memories 表（`type='ocr_result'`、`category='screenshot_ocr'`、`source='vision_ocr'`），metadata 存图片路径 + regions + 平均置信度；后续可用 memory_search 按文字反向搜历史截图 | `src/main/tools/modules/vision/ocrSearch.ts`、`ocrSearch.schema.ts` |
| `photo_archive` native tool | 包装 `photoLibraryTagger.archiveAlbum`，agent 调用一次完成"导出 → vision-tagger 批量 → 人脸聚类 → 入库 → 清理"整条链路，返回 `{ processed, faceCount, clusters[], topThemes[], memoryIds[] }` | `src/main/tools/modules/vision/photoArchive.ts`、`photoArchive.schema.ts` |
| Photos.app native connector | 新增 `photos` 连接器（跟 mail/calendar/reminders 同形态），暴露 `list_albums` / `list_photos` / `export_photos` / `get_status` / `probe_access` / `repair_permissions` 6 个 action；用 unit/record separator 而非 `|` 避免相册名特殊字符冲突；首次访问触发 macOS 自动化授权弹窗，readiness 状态机管理 unchecked/ready/failed/unavailable | `src/main/connectors/native/photos.ts`、`src/main/connectors/registry.ts`、`src/shared/constants/misc.ts`（NATIVE_CONNECTOR_IDS 扩展） |
| photoLibraryTagger service | 编排 `photos.export_photos` → 顺序 spawn vision-tagger → cosine similarity 并查集聚类（默认阈值 0.6）→ 主题分类聚合 → 入 memories 表 → 清理临时目录；featurePrint 走 Float32Array view 不拷贝 buffer；失败照片计入 `failed` 不阻塞整体 | `src/main/services/desktop/photoLibraryTagger.ts` |
| `visionAnalysisService` 走 ModelRouter | 重写 `analyzeImageWithVisionDetailed`：从硬编码智谱 fetch 改为 `getModelForCapability('vision')` + `ModelRouter.getModelInfo(supportsVision)` + `inferenceWithVision`；自动适配 GPT-4o / Claude / Gemini / GLM-4.6V / Qwen-VL / MiMo-VL / Doubao-VL / Kimi 视觉等所有 vision-capable 主 LLM；用 `Promise.race(timeoutController)` 处理 timeoutMs | `src/main/services/desktop/visionAnalysisService.ts` |
| MemoryRecord type 扩展 | union 加 `ocr_result` + `photo_archive` 两个新类型，双 source-of-truth 同步：`src/main/protocol/types/repositories.ts` + `src/shared/ipc/types.ts` | 两边都改 |
| VISION_CAPABLE_MODELS 常量 | 文档值，列出所有支持 vision 的主流 model id（运行时仍以 `model-catalog.json` 的 `capabilities: ['vision']` 为权威标识） | `src/shared/constants/models.ts` |
| Tauri 分发集成 | 两个 Swift binary 加入 `bundle.resources`，DMG 自动打包；`.gitignore` 同步排除两个 binary 产物（跟 `system-audio-capture` 同形态） | `src-tauri/tauri.conf.json`、`.gitignore` |

**架构边界澄清**：

- **MCP vs Connector 是两条独立路径**（详见 [native-app-integration.md](./architecture/native-app-integration.md)）：MCP 走 stdio/SSE 协议跨进程，给跨平台/可移植能力扩展用；connector 在 main process 内调 AppleScript，给绑死 macOS 系统应用的硬集成用。**Photos.app 走 connector 不走 MCP**——AppleScript 仅 macOS、性能更好、就绪状态管理更紧密。
- **OCR / vision-tagger 走 Swift binary 而不是 MCP server**：macOS Vision Framework 仅本机有效，不需要 MCP 的跨进程/跨平台抽象；binary 跟 `system-audio-capture` 同形态共享 build/分发流程。
- **`visionAnalysisService` 重构对外部调用方完全透明**：保留 `analyzeImageWithVision` / `analyzeImageWithVisionDetailed` 两个外部函数签名不变，所有上游（imageAnalyze tool、screenshot --analyze、browserAction、image_annotate）自动受益于"用户主 LLM 优先"路由。
- **photoLibraryTagger 顺序而非并行处理 vision-tagger**：避免 CPU/内存争抢，单张 ~200ms 够用；大相册（N>5000）的 O(N²) 聚类后续可优化为 HNSW 近似最近邻。
- **人脸聚类不主动起人名（隐私）**：默认 `person-1/2/...` 占位 cluster id，用户后续可重命名；特征向量留在本机 memories 表，零云端上传。

### v0.16.75 Agent Neo 管理面、外部 Agent Engine 与 In-App 验证（2026-05-15 ~ 2026-05-17）

这一轮把运行时、设置、验证和运营入口补成一条产品链路。架构重点是：品牌切到 Agent Neo，本地 Provider Key 成为默认模型边界，外部 agent 作为受控 engine 接入，生成物验证进入 app 内可见面板，管理类入口统一走 settings/admin guard。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Agent Neo 品牌层 | Tauri bundle、icon、Info.plist、MCP server、terminal、About/Update 和 landing page 文案切到 Agent Neo；仓库名与历史文档名继续保留 Code Agent | `src-tauri/tauri.conf.json`、`src-tauri/icons/*`、`public/code-agent/index.html`、`src/main/prompts/identity.ts` |
| 本地模型配置 | 删除 server-side `cloud-proxy` provider；`ModelSettings` / onboarding 引导用户配置本地 API Key；模型请求由 `modelConfigResolver` 和 provider wrappers 读取本机配置 | `src/main/agent/orchestrator/modelConfigResolver.ts`、`src/main/model/modelRouter.ts`、`src/renderer/components/onboarding/ModelOnboardingModal.tsx`、`src/renderer/components/features/settings/tabs/ModelSettings.tsx` |
| Agent Engine 抽象 | `AgentEngineKind = native / codex_cli / claude_code`；外部 engine 检测版本、生成 descriptor、通过 `codex exec --json` 或 `claude -p --output-format stream-json --permission-mode plan` 运行，并把事件归一为 session engine metadata | `src/shared/contract/agentEngine.ts`、`src/main/services/agentEngine/*`、`src/main/ipc/agentEngine.ipc.ts`、`src/web/routes/agent.ts` |
| 外部 engine 安全边界 | 外部 engine 只允许 manual chat session、workspace cwd 内、read-only permission profile；启动命令、cwd、log path 和 output refs 写入 task ledger | `src/main/services/agentEngine/agentEngineGuards.ts`、`codexCliAdapter.ts`、`claudeCodeAdapter.ts`、`src/main/tasks/backgroundTaskLedger.ts` |
| Agent Engine UI | ModelSwitcher 合并模型、reasoning effort 和 engine 选择；Capability Center 把 agent engine 当成能力卡，展示安装/运行/权限/风险状态 | `src/renderer/components/StatusBar/ModelSwitcher.tsx`、`src/main/services/capabilities/agentEngineCapabilityItems.ts`、`CapabilityCenterSettings.tsx` |
| 会话历史导入 | Codex / Claude jsonl 历史可扫描、预览、标准化，供接力、复盘和 review 使用 | `src/main/services/agentEngine/agentEngineHistoryImport.ts` |
| Capability Center 本地 registry | `CapabilityKind` 扩到 `agent_engine / skill / mcp_template / tool_bundle / channel_adapter / workflow_recipe / connector`；本地 curated registry 生成 disabled MCP draft，支持删除和回滚 | `src/shared/contract/capability.ts`、`docs/capabilities/*`、`src/main/services/capabilities/*`、`src/renderer/hooks/useCapabilityInventory.ts` |
| 统一记忆管理 | memory import、knowledge inbox decision、memory entry runtime、injection trace、seed injector 与 Settings Memory UI/Knowledge Memory Panel 打通 | `src/main/memory/*`、`src/main/ipc/memory.ipc.ts`、`src/renderer/components/features/settings/tabs/MemoryTab.tsx`、`KnowledgeMemoryPanel.tsx` |
| In-App HTML Validation | `validate_html_in_app` 作为 vision tool 调起 renderer 右侧 iframe 面板，复用 `BrowserInteractionStep` DSL 执行 click/hover/type/press/wait 与 expect 断言 | `src/main/tools/modules/vision/validateHtmlInApp.ts`、`src/shared/contract/browserInteraction.ts`、`src/main/services/inAppValidationService.ts`、`InAppValidationPanel.tsx` |
| Managed Browser Surface | Browser relay extension、`BrowserRelayService` 和 `BrowserSurfacePanel` 让托管浏览器从底层工具变成可查看 sidecar 面板 | `resources/browser-relay-extension/*`、`src/main/services/infra/browserRelayService.ts`、`src/renderer/components/features/browser/BrowserSurfacePanel.tsx` |
| Background Task Ledger | shell/background task、PTY 和外部 engine 输出进入统一 `Task / TaskEvent / TaskNotification / TaskOutputRef` 合同，当前 session 可 drain 通知并打开输出引用 | `src/shared/contract/backgroundTask.ts`、`src/main/tasks/backgroundTaskLedger.ts`、`backgroundTaskLedger.ipc.ts`、`useBackgroundTaskSync.ts` |
| Handoff proposals | runtime 在长任务尾部生成 handoff proposal stream，TaskPanel 通过 `HandoffCard` 展示可接力摘要 | `src/main/handoff/*`、`src/main/prompts/handoff.ts`、`src/renderer/components/TaskPanel/HandoffCard.tsx` |
| Artifact repair Route A | artifact repair 改为 full-rewrite-first；repair admission/guard/context assembly 继承 baseline 和 failures，P3 monotonic gate 阻止无界修复循环 | `src/main/agent/runtime/artifactRepair*`、`src/shared/constants/repair.ts`、`scripts/acceptance/platformer-gameplay-generation.ts` |
| Settings / Admin guard | Settings 增加 Workspace、Automation、Data、Model、Capability、管理页；admin IPC 统一走 `adminGuard`，用户 dashboard 与邀请码由 Supabase RPC 支撑 | `src/renderer/components/features/settings/*`、`src/main/ipc/adminGuard.ts`、`src/main/services/admin/adminService.ts`、`supabase/migrations/20260516000000_user_invite_management.sql` |
| 可选自动更新 | Tauri updater、release bundle、manifest 生成和 Update Settings 页面接入；启动时只在需要用户处理时提示 | `src-tauri/tauri.conf.json`、`scripts/tauri-update-manifest.mjs`、`scripts/tauri-release-bundle.sh`、`UpdateSettings.tsx` |
| 分发安全 gate | release build 关闭 renderer/web server sourcemap，Tauri resources 移除 `webServer.cjs.map`；`release:security-scan` 扫描一方 map、sourceMappingURL、src/tests/docs、env/私钥，并接入 `tauri:bundle`、`tauri:release:bundle` 和安装脚本 | `docs/security/2026-05-17-agent-neo-distribution-hardening.md`、`scripts/release-security-scan.mjs`、`esbuild.config.ts`、`vite.config.ts`、`vite.web.config.ts` |

**架构边界澄清**：
- Agent Engine 是受控适配层，不共享外部 CLI 的全量权限；Codex/Claude 默认 read-only，并且 cwd 必须落在当前 workspace 内。
- Capability Center 当前完成本地 curated registry 与 disabled draft；远程 marketplace、自动启用和远程执行仍保持在后续路线。
- In-App Validation 只承诺验证本地/生成的 HTML artifact；真实网站、反 bot、native menu、drag-and-drop 仍交给 Playwright/CDP 或人工接管。
- 管理页的前端隐藏只做体验优化，真正边界在 `adminGuard`、Supabase RLS 和 admin RPC。
- 分发安全 gate 只保证客户端包少带内部材料；license、entitlement、能力市场、付费策略和高价值 prompt 仍应服务端化。

### 2026-05-22 发布链、Agent Engine 模型目录与 Web 持久化状态

这一轮把 Agent Neo 的发布入口和运行时依赖再收紧一层：外部 Agent Engine 的模型选择改由签名控制面发布，显式模型不再默认偷偷跨 provider 降级；Web 模式把会话历史是否真正落库暴露给 UI；macOS 包内置 Node，避免用户机器 Node 版本和 `better-sqlite3` ABI 不匹配。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Agent Engine 签名模型目录 | 控制面新增 `agent_engine_model_catalog` artifact；主进程验 Ed25519 envelope，失败回退内置 catalog；`ModelSettings` 保存本机默认模型，`ModelSwitcher` 对 Codex/Claude 展示 catalog 模型，不混进普通 Provider 模型 | `src/main/services/agentEngine/agentEngineModelCatalog.ts`、`src/shared/agentEngineModelCatalog.ts`、`src/renderer/components/StatusBar/ModelSwitcher.tsx`、`src/renderer/components/features/settings/tabs/ModelSettings.tsx` |
| 外部 engine 模型执行 | session engine metadata 增加 `model`；Codex CLI 通过 `codex exec --model ...`，Claude Code 通过 `claude -p --model ...`；选择 engine 时同时保存 workspace cwd，防止外部 CLI 从错误目录启动 | `src/shared/contract/agentEngine.ts`、`agentEngineGuards.ts`、`codexCliAdapter.ts`、`claudeCodeAdapter.ts`、`src/renderer/stores/sessionStore.ts` |
| 显式模型降级边界 | `ModelRouter` 和 vision capability fallback 只在 `modelConfig.adaptive === true` 时跨 provider fallback；用户点选具体模型时，失败应暴露原 provider 错误，不再自动换模型 | `src/main/model/modelRouter.ts`、`src/main/agent/runtime/contextAssembly/inference.ts`、`src/main/session/modelSessionState.ts` |
| Web 会话持久化健康 | `/api/health` 返回 `persistence`；状态栏和 Data Settings 在 SQLite 不可用时显示“历史未持久化”；新增 acceptance smoke 验证 webServer 重启后 session 可恢复 | `src/web/routes/health.ts`、`src/web/helpers/sessionCache.ts`、`src/renderer/components/StatusBar/PersistenceStatus.tsx`、`scripts/acceptance/session-persistence-smoke.ts` |
| macOS 包内置 Node | release/prebuild 准备 `dist/bundled-node/bin/node`；Tauri release 优先用包内 Node 启动 webServer，并在 release verify 阶段用同一 Node 加载 `better-sqlite3.node` | `scripts/prepare-bundled-node.mjs`、`src-tauri/src/main.rs`、`src-tauri/tauri.conf.json`、`scripts/verify-macos-release.sh` |
| 控制面与下载入口 | release bundle、env generator、smoke 都纳入 Agent Engine 模型目录；官网 DMG 下载改走 `/api/update?action=download`，由 update API 找最新 GitHub Release asset 或 channel override | `scripts/control-plane-release-bundle.mjs`、`scripts/generate-control-plane-env.mjs`、`scripts/control-plane-smoke.mjs`、`vercel-api/lib/updateMetadata.ts`、`public/code-agent/index.html` |

**架构边界澄清**：

- Agent Engine 模型目录只控制外部 CLI 的模型列表和默认值，不接管 Native Agent Neo 的 Provider API Key 或普通模型路由。
- `agent_engine_model_catalog` 走与 cloud config / prompt / capability registry 相同的签名 envelope；远程不可用、未配置公钥或验签失败时，只能用内置兜底。
- Web 持久化状态是用户可见的运行时健康信号，不是同步状态；它只说明当前 webServer 会话历史是否落到本机 SQLite。
- 包内 Node 是 release runtime 依赖，不是 managed runtime asset；它必须在签名/公证前进入 Tauri resources，并由 release verify 检查 ABI。

### 2026-05-13 ~ 05-14 Context Health 溯源 + 取消级联 + Computer-use MCP 入口归位 + 工作台面板群

这一轮把上下文 token 的来源可观测性、多 agent 取消的级联语义、Computer/Screenshot 的 MCP 入口归位，以及一批聊天主链路诊断面板收进主产品面。架构上复用既有 `ContextHealthService`、`subagentExecutor`、native ToolModule registry 和 workbench 面板体系，没有引入新的并行运行时。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Context Health Token 溯源 | `TokenBreakdown` 新增 `bySource`（rules / skills / mcp / subagents / fileReads / conversation 六维）；`ContextHealthService.recordSourceContribution(sessionId, source, tokens, mode)` 支持 add/set，`clearSourceContribution` / `resetSourceContributions` / `clearMcpServerAcrossSessions` 负责卸载与压缩后清零；200ms 防抖广播 `context:health:event` | `src/main/context/contextHealthService.ts`、`src/shared/contract/contextHealth.ts` |
| Token 上报点 | skill mount/unmount（`sessionSkillService`）、SessionStart AGENTS.md 注入（`agentsHooks`）、fileRead（`read.ts`）、MCP 工具结果（`mcpInvoke`）、subagent 输出（`task.ts` / `spawnAgent.ts`）统一调用 `recordSourceContribution` 上报 token 占用 | `src/main/services/skills/sessionSkillService.ts`、`src/main/hooks/agentsHooks.ts`、`src/main/tools/modules/*` |
| Context Panel UI | workbench 新增 `context` tab，`ContextPanel` 容器挂载 `ContextHealthPanel`；一级展开按消息结构（systemPrompt / messages / toolResults / toolDefs），二级展开按产品来源并支持 Skills/MCP/Subagents 嵌套折叠；每项提供跳转（联动 SkillsPanel highlight）和 ✕ 卸载（MCP 走 `setServerEnabled` IPC，skill 走 unmount） | `src/renderer/components/ContextPanel.tsx`、`src/renderer/components/ContextHealthPanel.tsx` |
| 取消级联契约 | `CancellationReason` 区分 CASCADE（`user-cancel` / `session-switch` / `parent-cancel`，触发 `spawnGuard.cancelAll()`）与 NON_CASCADE（`child-error` / `timeout` / `idle-timeout` / `budget-exceeded`，只影响单 agent）；单个 child 抛错不波及兄弟 | `src/shared/contract/cancellation.ts` |
| 四阶段 Shutdown | `initiateShutdown` 走 Signal（abort）→ Grace（5s 等工具收尾）→ Flush（2s 经 TeamManager 持久化 findings）→ Force（返回 partial results）；idle watchdog 监测 2 分钟无 stream/progress 自动 `abort('idle-timeout')` | `src/main/agent/shutdownProtocol.ts`、`src/main/agent/subagentExecutor.ts` |
| Per-agent Stop UI / 信号桥接 | `SwarmMonitor` 每个 agent 卡片可独立 Stop，走 `swarm:cancel-agent` IPC（`spawnGuard.cancel` 或 `parallelCoordinator.abortTask`）；`subagentExecutor` 用 `createChildAbortController` 把 parent abortSignal 与内部 timeout 单向桥接到子控制器，child abort 不反向传播 | `src/renderer/components/features/swarm/SwarmMonitor.tsx`、`src/main/ipc/swarm.ipc.ts`、`src/shared/constants/timeouts.ts`（`CANCELLATION_TIMEOUTS`） |
| Computer-use MCP 入口归位（Level 1） | Computer + Screenshot 包装成 native ToolModule（`computer.ts` + `computer.schema.ts`），统一走 MCP 工具入口；handler 做权限检查后委托 legacy `ComputerTool.execute`，结果经 `adaptVisionLegacyResult` 适配。当前是 wrapper-mode，占位到 ToolModule 协议层，为后续 Level 2 原生重写留接口 | `src/main/tools/modules/vision/computer.ts`、`computer.schema.ts` |
| Workbench 诊断面板群 | Context Health、Knowledge Memory Audit（`KnowledgeMemoryPanel` + `memory.ipc.ts` 的 `MemoryAuditRequest`/`serializedAuditMemory`）、Activity Entry（`ActivityPanel` + `activityContextProvider`）、Computer-use Diagnostics（`computerUseWorkbench.ts` + `computerSurface.ts`）、Time Capability（集中读 `timeouts.ts`）五类诊断面板进入聊天主链路；Workspace Preview 露出活动与工作区产物（`WorkspacePreviewPanel` + `memoryActivityNavigation`） | `src/renderer/components/features/{knowledge,activity}/*`、`src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/utils/computerUseWorkbench.ts` |
| Runtime Steer | 运行中途用户输入经 `steer()` → `messageProcessor.injectSteerMessage()` 排队进当前轮次消息历史并持久化，置 `needsReinference=true` 下轮推理；guided UI 用 `RuntimeInputDelivery` 元数据标记 `queued_next_turn`；web host follow-up 在 `/web/routes/agent.ts` 接 `clientMessageId` 字段供 prompt rewind 溯源 | `src/main/agent/runtime/conversationRuntime.ts`、`messageProcessor.ts`、`src/web/routes/agent.ts` |
| Vision 模型切换 | `ZHIPU_VISION_MODEL` 切到免费档 `glm-4.1v-thinking-flash`（带推理链），8 个视觉模块（视觉分析 / 图像标注 / 截图 / PPT 生成等）统一从常量读取 | `src/shared/constants/models.ts` |
| Context builder 工作目录边界 | 系统提示新增 `workingDirBoundaryInfo` 块，澄清三点：工作目录是相对路径基准而非任务边界、系统级查询可访问 home 绝对路径、续接指令保留上文任务作用域 | `src/main/agent/messageHandling/contextBuilder.ts` |
| Channel / 本地活动隐私防火墙 | 渠道入站消息与本地桌面活动在落地/分发前统一脱敏：`channelPrivacyFirewall` 三模式（local-redact/allow-raw/off）+ 飞书 `feishuPrivacy` 接入 + `ChannelsSettings` 策略 UI；`localActivityPrivacyFirewall` 脱敏 `DesktopActivityEvent` 字段，`screenshotPrivacyRedactor` 用 sharp 做截图区域级 blur；`sensitiveDataGuard` 补 SSN / 信用卡（Luhn 校验）确定性 PII 脱敏；`native_desktop.rs` Rust 侧对称脱敏（URL 凭证 / home 路径 / email / 信用卡 Luhn） | `src/main/channels/privacy/channelPrivacyFirewall.ts`、`src/main/services/activity/localActivityPrivacyFirewall.ts`、`src/main/services/activity/screenshotPrivacyRedactor.ts`、`src/main/security/sensitiveDataGuard.ts`、`src-tauri/src/native_desktop.rs` |

**架构边界澄清**：
- Context Health 溯源是观测层增强，`bySource` 为 `TokenBreakdown` 上的可选维度，不改变既有消息结构统计口径。
- 取消级联区分 CASCADE / NON_CASCADE 是核心语义：父级取消向下穿透，子级失败/超时只熔断自身，避免一个 subagent 出错拖垮整个 Agent Team。
- Computer-use MCP 入口归位是 Level 1 wrapper-mode：当前仍委托 legacy 实现，用户可见的 Computer 工具语义不变，Level 2 原生重写后再替换执行内核。
- Prompt rewind web host 暴露依赖 `ConversationEnvelope.clientMessageId`，让 web 端消息拥有稳定标识供 rewind 追踪。
- 隐私防火墙是 Sensitive Data Guard（Scope 1 派生数据脱敏层）的延伸：channel 入站消息和本地桌面活动作为新的脱敏 sink 接入，raw session 消息仍保持全保真，详见 [architecture/sensitive-data-guard.md](./architecture/sensitive-data-guard.md)。

### v0.16.74 Prompt / Hook / Prompt Rewind（2026-05-11）

这一轮把可配置 prompt、Hook 可观测性和会话回退收进主产品面。架构上复用既有 domain IPC、SessionRepository、FileCheckpointService 和 turn timeline，没有引入新的并行会话模型。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Prompt Registry | `applyOverride()` 将 prompt 常量包成实时字符串；`dynamic()` 让组合 prompt 每次构建都重新读取 override；`promptIndex` 负责副作用注册所有 prompt 模块 | `src/main/prompts/registry.ts`、`src/main/prompts/promptIndex.ts`、`src/main/prompts/builder.ts` |
| Prompt Manager UI | `domain:prompt` 提供 `list/get/set/reset/preview/debugSystemPrompt`；UI 按 category 展示默认文本和当前生效文本，保存到 `~/.code-agent/prompts-overrides/<id>.md` | `src/main/ipc/prompt.ipc.ts`、`src/renderer/components/features/prompts/PromptManagerModal.tsx` |
| Hook Settings | `domain:hook` 汇总全局/项目 hook 配置、enabled/unused events、matcher、source、decision/observer、parallel，并能创建/打开/定位配置文件 | `src/main/ipc/hook.ipc.ts`、`src/renderer/components/features/settings/tabs/HooksSettings.tsx` |
| Hook Activity in Chat | HookManager 记录最近 50 条 trigger history，并通过 turn timeline 注入 `hook_activity`；TurnCard 在用户提示词下方展示本轮 hook 数量、状态、耗时和事件 chips | `src/main/hooks/hookManager.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`src/renderer/components/features/chat/TurnCard.tsx` |
| CLI hooks 默认启用 | CLI `buildCLIConfig()` 显式设 `enableHooks:true`，`AgentLoop` 不再只在 planning mode 下运行用户 Hook | `src/cli/bootstrap.ts`、`src/cli/types.ts` |
| Chat workspace defaults | 新建会话、新 tab、初始 bootstrap 传 `workingDirectory:null`，避免继承上一条代码工作区；TitleBar 选择目录后通过 `session:update` 持久化 | `src/renderer/components/Sidebar.tsx`、`src/renderer/components/TitleBar.tsx`、`src/renderer/stores/sessionStore.ts` |
| Prompt Rewind | `domain:session/rewindToPrompt` 拒绝 running session，找到锚点用户消息与最近 checkpoint，回滚文件，隐藏锚点及之后 active 消息，把原 prompt/attachments 回填输入框，并写 `session_rewinds` 审计 | `src/main/app/agentAppService.ts`、`src/main/services/core/repositories/SessionRepository.ts`、`src/main/services/checkpoint/fileCheckpointService.ts`、`src/renderer/components/ChatView.tsx` |
| Web 模式对齐 | `src/web/webServer.ts` 增加同名 `rewindToPrompt` action，Web 端会话 API 与 Tauri IPC 保持功能一致 | `src/web/webServer.ts` |

**持久化边界**：
- `messages.visibility = active | rewound` 是 active transcript 的过滤条件；rewound 消息保留在库中用于审计、同步和回放，不再出现在普通 `getMessages()`。
- `session_rewinds` 记录 anchor prompt、隐藏消息列表、checkpoint message、文件恢复/删除数量和错误列表。
- Supabase 侧迁移 `20260511000000_prompt_rewind.sql` 同步增加 `messages.visibility` 与 `public.session_rewinds`，并用 RLS 限制到当前用户。

### v0.16.72-73 Native Protocol + Artifact Acceptance + Isolation + Quality Gates（2026-05-01 ~ 2026-05-10）

这一轮同时推进工具协议、artifact 验收、多 agent 浏览器/桌面隔离、类型/异步/清理门禁。文档口径按能力域记录，避免把它误读成零散 refactor。

| 能力域 | 当前闭环 | 关键文件 / 文档 |
|------|---------|----------------|
| Level 1 native tool protocol | Web/Search、Excel、Document、MCP、Skill、LSP、Multiagent、Planning、Vision、Network/Media/Docgen/PPT 按 wave 迁到 native module；旧 wrappers/legacy path 分批删除；IPC schema 不变的工具保留前端兼容 | `src/main/tools/modules/*`、`src/main/tools/registry.ts`、`docs/migrations/legacy-tools-removal-sop.md` |
| Tool reliability | WebFetch 强制 URL；toolSearch 无 callable 命中时明确失败；Edit old_text mismatch 返回最近 anchor lines；LSP 扩到 100+ extension map 并能返回 install hint；shell 统一走 command policy | `src/main/tools/modules/network/*`、`src/main/tools/utils/anchorHint.ts`、`src/main/lsp/*`、`src/main/tools/modules/shell/commandPolicy.ts` |
| Runtime / Web / Context hardening | compaction/browser recovery、partial-failure trace、Web 401/403 token mismatch recovery、run 前持久化 user message、activeAgentLoops flush、telemetry classifier、token-trigger compaction、context fill 包含 tool schemas | `src/main/context/*`、`src/web/webServer.ts`、`src/main/telemetry/*`、`src/renderer/components/features/chat/*` |
| Artifact acceptance / repair | AcceptanceRunner、通用 repair toolkit、Game subtype registry、Best-of-N + repair cap + monotonicity gate、DeckVerifier + schema/narrative probes、DashboardVerifier + browser visual smoke + state_change_on_click probe（Delivery Review / Preview Feedback 已于 v0.16.79 随 evaluation 子系统移除） | `src/main/agent/runtime/acceptance/*`、`src/main/agent/runtime/repair/*`、`src/main/agent/runtime/game/*`、`src/main/agent/runtime/deck/*`、`src/main/agent/runtime/dashboard/*` |
| Browser / Computer multi-agent isolation | 子 agent 工具调用带 `agentId`，BrowserService pool 提供 per-agent cookie/storage 隔离；ephemeral Chromium FIFO semaphore；ComputerSurface 写动作 mutex；新增 mouse_down/up、open_application、write_clipboard、computer_batch、hold_key、triple_click、cursor_position | `src/main/services/infra/browserPool.ts`、`src/main/services/infra/browserService.ts`、`src/main/services/infra/playwrightLaunchSemaphore.ts`、`src/main/services/desktop/computerSurfaceLock.ts`、`src/main/tools/vision/computerUse.ts`、`tests/smoke/*` |
| Multi-agent signal propagation | subagent dispatch 将 `agentId` 注入 `ToolContext`；`effectiveSignal` 透传 `modelRouter.inference`，避免子 agent cancel / abort 丢到模型调用外 | `src/main/agent/multiagentTools/*`、`src/main/model/modelRouter.ts` |
| Typed IPC / Web payload | `shared/ipc` zod schemas、`defineHandler`、renderer `typedInvoke`、web `parseBody` 建成 typed IPC/HTTP payload 校验起点 | `src/shared/ipc/*`、`src/main/platform/ipcRegistry.ts`、`src/renderer/services/typedInvoke.ts`、`src/web/helpers/typedBody.ts` |
| Provider wrappers / symmetry | OpenAI / Anthropic / DeepSeek / Gemini 解析走 zod wrappers，SSE stream 切到 wrappers；51 fixtures contract tests；provider symmetry 脚本接 Husky + GitHub Actions | `src/main/model/providers/wrappers/*`、`scripts/check-provider-symmetry.sh`、`.husky/pre-commit` |
| Async correctness / god-file split | `Promise.race` → `withTimeout`，timer graceful shutdown + `.unref()`，`new URL()` try/catch；HookManager / telemetryQueryService / TaskDAG 按执行引擎、replay、graph algorithms 拆分 | `src/main/services/infra/timeoutController.ts`、`src/main/hooks/*`、`src/main/evaluation/*`、`src/main/agent/taskDag.ts` |
| Cleanup / architecture retirement | cloud agent module、legacy provider functions、P0-5 POC subsystem、Decorated tools、orphan resume、unused exports 清理；Message 类型统一到 `shared/contract`；Codex sandbox/crossVerify 退场，改成 bash command policy | `src/main/agent/*`、`src/main/model/*`、`src/main/tools/*`、`src/shared/contract/*` |

**架构边界澄清**：
- Native protocol migration 是运行时入口归位，不改变用户看到的工具语义；同名工具、alias 和 IPC contract 尽量保持兼容。
- Artifact acceptance 采用"按 artifact kind 拥有自己的 verifier"的策略；ADR-016 明确暂不抽 `ArtifactKindVerifier` 顶层接口，避免把 deck 的 in-memory 验证和 dashboard 的 browser 验证硬塞进同一形态。
- Browser/Computer 隔离解决的是 Agent Team 并发时的状态串扰，默认单 agent 浏览器语义保持不变。
- 5/10 的 cleanup 是架构退休：删除不再 active 的 POC/cloud/legacy path，不作为新产品入口宣传。

### v0.16.66 Agent Runtime Capability Hardening (2026-04-27)

这一轮把 2026-04-27 的 P1/P2 capability audit 从计划推进到代码和定向测试闭环。范围集中在 agent runtime、tool、MCP、persistence、swarm、eval/replay 的生产链路。

| 模块 | 当前闭环 | 关键文件 |
|------|---------|---------|
| Run lifecycle | `ConversationRuntime.run` 统一 terminal path；`completed / failed / cancelled / interrupted` 都进入 `RunFinalizer`；cancel 发 `agent_cancelled`，failure 不绕过 finalizer | `src/main/agent/runtime/conversationRuntime.ts`、`runFinalizer.ts` |
| Run-level abort | `abortSignal` 贯穿 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> ProtocolToolContext`，长 Bash/http 等工具可被 run cancel | `src/main/agent/runtime/toolExecutionEngine.ts`、`src/main/tools/toolExecutor.ts`、`src/main/tools/dispatch/toolResolver.ts` |
| Chat run owner | desktop chat send/interrupt 走 TaskManager-owned path，避免 chat status 与 task state 两套 owner 漂移 | `src/main/app/agentAppService.ts`、`src/main/task/TaskManager.ts` |
| Tool 权限与 MCP | `Bash/bash` 归一；顶层审批结果通过 `approvedToolCall` 传给 resolver；MCP dynamic tool 可 direct execute 到 `MCPClient.callTool`；ToolSearch 标记 `loadable/notCallableReason` | `toolExecutor.ts`、`toolResolver.ts`、`mcpToolRegistry.ts`、`toolSearchService.ts` |
| Skill 安全边界 | project/user skill 的 `allowed-tools` 不再自动扩权；只有 builtin/plugin skill 可进入自动 preapproval | `src/main/tools/modules/skill/skill.ts`、`src/main/services/skills/skillParser.ts` |
| Multiagent | parallel executor 有真实 inbox；`dependsOn` 按成功依赖门控；失败/blocked/cancelled 都进入 aggregation；run-level cancel 阻止 pending agent 启动 | `parallelAgentCoordinator.ts`、`sendInput.ts`、`resultAggregator.ts` |
| 持久化恢复 | todo、Task tool task、context intervention、compression state、persistent system context、pending approval kind hydrate 都有 session-scoped durable path | `SessionRepository.ts`、`taskStore.ts`、`contextInterventionState.ts`、`runtimeStatePersistence.ts` |
| Replay / Eval | structured replay join model/tool/event evidence；`real-agent-run` gate 校验 `sessionId + replayKey + telemetryCompleteness`，缺关键证据会 fail/degraded | `telemetryQueryService.ts`、`testRunner.ts`、`ExperimentRunner.ts` |

验证口径：P1/P2 计划文档列出的 blocker 已在 unit/renderer/security 定向测试和 `npm run typecheck` 层面闭环；真实 app 长 run pause/resume、UI cancel 长命令、Agent Team 多 agent、reload recovery 仍按 smoke 风险列在对应文档里，不写成已完成的产品验收。

### v0.16.67-71 Hardening + 评测扩面 + Design Brief 生产化（2026-04-27 ~ 2026-04-29）

两天的 50+ commits 集中在：基建守门、安全收口、目录归位、新模型接入、Design Brief 全链路、评测扩面、调试快照与 CLI debug 命令树、channel 实时事件。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Tauri Updater 安全 (M6.a / M6.b) | cloud-api 下发 `sha256` 字段；updater 落盘前哈希校验；`open_update_url` 阻止二进制下载，仅可在浏览器打开 release 页 | `src/main/services/updater/*`、`vercel-api/`、`docs/releases/` |
| Updater artifact 关闭 | `tauri.conf.json` 关闭自动 updater artifact 生成，避免无签名/无哈希产物意外发布 | `src-tauri/tauri.conf.json` |
| EventBus / EventBridge 归位 | 事件运行时从 `src/main/protocol/` 迁到 `src/main/services/eventing/`，`vi.mock` 路径同步更新；事件分层与三通道契约不变 | `src/main/services/eventing/*`、`tests/eventing/*` |
| Tool dispatch 归位 (M1.2) | tool 分发从 `protocol/` 拆出，统一到 `src/main/tools/dispatch/`，`ToolResolver` 与 abort 链贯通保持原状 | `src/main/tools/dispatch/toolResolver.ts` |
| 调试快照体系 (ADR-014) | `turn_snapshots` + `compaction_snapshots` 两张表 + 写入器；step pause；settings "调试快照" section 含 retention selector；`data` 域 IPC 暴露 stats/clear/setRetention；CLI `code-agent debug` 命令树复用同一能力 | `src/main/agent/runtime/turnSnapshotWriter.ts`、`src/main/context/compactionSnapshotWriter.ts`、`src/main/ipc/data.ipc.ts`、`src/cli/commands/debug/*` |
| 本地 Ollama 评测 (ADR-013) | 评测中心 `MODEL_OPTIONS` 显式声明 provider；`evaluation.ipc.ts` 接收 provider 字段并按 provider 路由 API key；主聊天 `ModelSwitcher` unhide local provider。**评测中心 UI 与 `evaluation.ipc.ts` 已于 v0.16.79 移除**，主聊天 `ModelSwitcher` 的 local provider 仍在 | `src/renderer/components/StatusBar/ModelSwitcher.tsx` |
| `evalEligible` catalog 字段 | `model-catalog.json` 标记可评测模型，`CreateExperimentDialog` 模型列表从 `PROVIDER_MODELS` 派生并按 `evalEligible` 过滤，避免视觉/嵌入模型出现在主聊天打分对象里 | `src/shared/model-catalog.json`、`src/shared/constants/models.ts` |
| SWE-bench docker harness (ADR-015) | 独立 `eval/swe-bench/`，colima + 官方 docker image；`validation.ts` 双层 executable validation；CLI `--mode docker \| python` 默认 docker；Django <15min 子集 9/10 first-shot；不污染 chat agent 主链路 | `eval/swe-bench/*`、`docs/decisions/015-swebench-docker-eval-harness.md` |
| 小米 MiMo provider | 新增 `XiaomiProvider`（OpenAI 兼容，新加坡 token-plan 节点），注册 4 个模型（mimo-v2.5-pro / v2.5 / v2-pro / v2-omni 多模态）；`DEFAULT_PROVIDER` 切到 `xiaomi`，`DEFAULT_MODEL` 切到 `mimo-v2.5-pro`；CLI / IPC / Web 各入口注册 `XIAOMI_API_KEY` env | `src/main/model/providers/xiaomiProvider.ts`、`src/shared/constants/providers.ts`、`src/shared/constants/defaults.ts`、`scripts/acceptance/xiaomi-smoke.ts` |
| 模型 capability/缩写 单源真理 | 散落在前后端的 capability map 与缩写映射收敛到 `src/shared/constants/models.ts`，前端只消费派生视图 | `src/shared/constants/models.ts` |
| SessionManager apiKey 剥离 | HTTP response 经 `SessionManager` 出口前显式 strip `ModelConfig.apiKey`，防止云同步 / Web 模式回传链路把密钥泄漏到 renderer 或日志 | `src/main/session/SessionManager.ts` |
| Audit Phase A (命令注入 + 默认模型硬编码) | 长期遗留 shell 拼接路径全部走 `execFile`；多处 `\|\| 'deepseek'` `\|\| 'kimi-k2.5'` 风格的硬编码 fallback 全部替换为 `DEFAULT_PROVIDER` / `DEFAULT_MODEL` 常量 | `src/main/`（多文件）；自检 `grep -rn "\|\| 'deepseek'"` |
| NetworkStatus closure-stale 修复 | `NetworkStatus` 闭包陈旧导致退避少一档，调整为读最新 state 而非 closure 捕获 | `src/main/network/networkStatus.ts` |
| `silenceAsync` observability helper | 新增 `silenceAsync` 包装高频 fire-and-forget 调用，6 处关键审计链路接入避免日志爆炸但保留诊断断点 | `src/main/utils/silenceAsync.ts` |
| Husky + lint-staged + 硬编码自检 | 提交前自动跑 `grep -rn "\|\| 'deepseek'"` 等自检规则，硬编码常量回潮即拦截 | `.husky/pre-commit`、`package.json` |
| `max-lines: 1000` ESLint 守门 | 1000 行上限作为 God File 硬护栏，19 个 legacy God File 进白名单逐步消化 | `.eslintrc`、`docs/audits/2026-04-27-codex-2day-burst-cleanup.md` |
| Supabase services 类型清理 | 一次性移除 18+ 处 `as any`，并修出 latent bug（B5 audit） | `src/main/services/sync/*` |
| Design Brief 生产化 (Phase A→C.3) | `src/design/`（direction-tokens + 5-dim critique）、`src/artifacts/question-form.ts`、`src/main/prompts/selfCritique.ts`、`src/main/prompts/questionForm.ts`、`src/main/app/workbenchTurnContext.ts` 把 brief 生产路径接进 envelope 与 system prompt；C.3 路线 A 借鉴 nexu-io 模式注入 silent self-critique pre-emit gate | `src/design/*`、`src/artifacts/*`、`src/shared/contract/designBrief.ts`、`src/main/prompts/selfCritique.ts` |
| Workspace Preview Panel | 右侧 artifact review workbench：承载 designBrief / questionForm / design_ppt / delivery review / preview feedback；反馈项可 resolve、dismiss 或 send back to chat；TaskMonitor scope inspector 与之联动 | `src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/components/QuestionFormPreview.tsx`、`src/renderer/hooks/useWorkspacePreviewModel.ts`、`src/renderer/utils/workspacePreview.ts` |
| Channel inbox / outbox 实时事件 | 入站 / 出站事件统一 IPC 通道，renderer 可 `list / dismiss`；当前 UI 入口由 TaskMonitor / 任务分解视图承接能力状态与事件摘要 | `src/main/channels/*`、`src/renderer/components/TaskPanel/TaskMonitor.tsx` |
| Chat-view 新会话首屏 | 新 session 首屏从"示例 prompt 卡"改为写邮件/排日程、做方案/文档/PPT、调研/对比、代码改动四类具体任务入口 | `src/renderer/components/ChatView.tsx` |
| ~~Eval Center Review Queue~~（v0.16.79 移除）| `SessionListView` 把待评 session 集中分桶，标注 replay 完整度与异常 case；行点击进详情；fatal inference error 熔断；DB 去重 | 整套 evalCenter UI + `testRunner.ts` 已随 evaluation 子系统删除 |
| Computer Surface `locate_role+targetApp` | 走 macOS background AX 直连指定 app 控件树，避免唤起前台；`type` / `key` 没有 background target 时降级前台键盘事件，bridge 显式 warn；文档 Computer / computer_use 别名映射 + 截图可见性规则 | `src/main/tools/computerUse.ts`、`src/main/tools/desktop.ts`、`docs/guides/computer-use.md` |
| CLI config 单源 | `CLIConfigService` 与 `ConfigService` 统一为同一份 config source，避免 CLI 模式与 Tauri 模式读到不同默认值 | `src/cli/config.ts`、`src/main/config/*`（PR #88） |

**架构边界澄清**：
- `services/eventing/` 与 `tools/dispatch/` 都是 `protocol/` 的"专项归位"，不引入新的运行时语义。`protocol/` 只保留跨进程消息契约，运行时实现回到各自能力域。
- Design Brief 工作流落点是 `src/design/`、`src/artifacts/`、`src/shared/contract/designBrief.ts` 三处，与主聊天 envelope 之间通过 `workbenchTurnContext` + `messageBuild` 串联。它对普通编程任务保持零打扰。
- 调试快照体系不依赖 telemetry / replay 旧链路，单独走 SQLite 双表，方便后续按 retention window 单独清理。

### v0.16.59 竞品追赶 (2026-04-11)

6 条并行工作流，17 commits，61 files，+3249 lines：

| 模块 | 新增能力 |
|------|---------|
| Provider 系统 | 火山引擎 + 本地模型 8 扩充 + Health Monitor 四状态机 + 连通性测试 |
| 错误处理 | 4 类新错误分类 + 可操作化 toast + 流式分阶段反馈 + 诊断面板 |
| 会话控制 | 推理强度 4 级 + Code/Plan/Ask 模式 + 暂停/恢复 + 检查点 Fork |
| 聊天显示 | 工具自动分组 + Thinking 摘要 + 消息编辑/重试 + Artifact 追踪 |
| 设置导航 | 设置搜索 + 会话搜索/项目分组 + MCP 添加 UI + 权限模式切换 |
| 安全 | postMessage 校验 + CSP + prompt injection 防护 + 图表路径统一 |

### v0.16.60-65 Workbench 面板整合 + Preview 扩能 (2026-04-18 ~ 2026-04-23)

40+ commits，围绕**右侧工作面板统一**和 **Preview 多模态能力**展开，消除 legacy 多面板抢宽度问题。

| 模块 | 新增能力 | 关键文件 |
|------|---------|---------|
| 统一 tab 模型 | `openWorkbenchTab` / `closeWorkbenchTab` 单一 action 替代 legacy `show*Panel`；Task/Skills/Files 单例 tab，Preview 多 tab | `src/renderer/stores/appStore.ts` |
| WorkbenchTabs 顶栏 | 右侧面板头部 tab bar，X 关闭后自动切到幸存 tab，tab 顺序稳定 | `src/renderer/components/WorkbenchTabs.tsx` |
| Preview 多格式 | 代码编辑器（ts/tsx/js/jsx/json/yaml/yml，CodeMirror 6）+ Markdown 编辑（md/csv/tsv/txt）+ CSV/TSV 表格 + 图片/PDF base64 | `src/renderer/components/PreviewPanel.tsx` |
| Preview LRU | `MAX_PREVIEW_TABS = 8` 上限，超出按最近未使用淘汰 | `appStore.ts` |
| File Explorer 同步 | 切换 session 时自动跟随 `workingDirectory`，内联新建 File/Folder，`openOrFocusTab` action | `src/renderer/components/features/explorer/FileExplorerPanel.tsx` + `stores/explorerStore.ts` |
| Tauri plugin-opener | Finder reveal / 外部打开路径经 Rust 插件，渲染进程通过 `@tauri-apps/plugin-opener` 调用 | `src-tauri/Cargo.toml` + `package.json` |
| Tauri plugin-dialog | 原生目录选择器替代 renderer 自绘弹窗；`workspace:selectDirectory` IPC 经 domain API 路由 | `src/renderer/services/workspaceService.ts` |
| Sidebar workspace grouping | Codex-style 按 workingDirectory 分组 + 折叠状态持久化 | `src/renderer/components/Sidebar.tsx` |
| 死代码清理 | CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle 及其 orphan state 全部移除；TitleBar 只保留 File/Skills/Task 三个 toggle | `src/renderer/components/TitleBar.tsx` + `App.tsx` |
| 稳定性护栏 | 恢复 session 不再卡"就绪"（sessionPresentation 修复）；Write tool row 文件名可点击 + Reveal | `src/main/session/sessionPresentation.ts` |

**架构要点**：ADR-011 定义的 Chat-Native Workbench 不变（聊天主链路仍是默认心智入口），本轮改动是在其上对**右侧 sidecar** 做物理整合。TaskPanel / SkillsPanel / PreviewPanel / FileExplorerPanel 共享同一宿主和同一 store action，职责分工不变。

---

### v0.16.65 Live Preview Visual Grounding (D6-D8) + 基础设施修复 (2026-04-24)

把"点 iframe 元素 → 源码位置 → Agent 改代码 → HMR 看效果"做成闭环。跨三处仓库：

- `code-agent`（主仓库）：10 commits，UI + 协议同步 + IPC + 基础设施修复
- `vite-plugin-code-agent-bridge`（独立仓库）：升级到 v0.2.0，新增 HMR restore 协议
- `visual-grounding-eval/spike-app`：测试用 fixture（协议消费者验证）

#### 数据流（从 iframe click 到 envelope context）

```
iframe click
  ↓ (bridge runtime, vite 插件编译期注入 data-code-agent-source="file:line:col")
postMessage {type:'vg:select', payload:SelectedElementInfo}
  ↓ (LivePreviewFrame message handler, 校验 event.source + expectedOrigin)
resolveAndSetSelectedElement
  ↓ (IPC domain:livePreview resolveSourceLocation, projectRoot=workingDirectory)
appStore.setSelectedElement(tabId, {file:absolute, relativeFile, line, column, tag, text, rect, componentName?})
  ↓ (用户发 Chat message)
composerStore.buildContext() 读 activePreviewTabId → tab.selectedElement → 拍回 nested SelectedElementInfo
  ↓
ConversationEnvelopeContext.livePreviewSelection 随 envelope 到 main 侧
```

`file` 存绝对路径（main 侧工具消费跨进程方便），`relativeFile` 存 bridge 原 DOM 属性里的 vite-root 相对路径（HMR restore 反查 DOM 用，两端形状对称）。

#### Bridge 协议 v0.2.0（独立 npm 包 + 主仓库 shared 同步）

| 消息 | 方向 | payload | 用途 |
|---|---|---|---|
| `vg:ready` | iframe → parent | `{url}` | bridge install 完成通告，parent 以此触发 restore 链路 |
| `vg:select` | iframe → parent | `SelectedElementInfo` | 用户 click 的结果 |
| `vg:hover` | iframe → parent | `SelectedElementInfo \| null` | hover 反馈（MVP 不消费，预留） |
| `vg:selection-stale` **(0.2.0 新增)** | iframe → parent | `{location}` | bridge 按 location 找不到元素时反馈，parent 清 appStore selection |
| `vg:simulate-click` | parent → iframe | `{selector}` | 编程触发 iframe 内点击 |
| `vg:clear-selection` | parent → iframe | - | 主动清空 selection |
| `vg:ping` | parent → iframe | - | 健康检测，bridge 回发 vg:ready |
| `vg:restore-selection` **(0.2.0 新增)** | parent → iframe | `{location}` | HMR 回流恢复。bridge 按 file+line+column 反查 DOM 重高亮；匹配失败回发 `vg:selection-stale` |

匹配策略：先精确 file+line+column；次选 file+line（column 最易漂移，作 tiebreaker）。

#### HMR 回流恢复 selection（P3 核心）

```
用户点元素 → appStore 有 selection
  ↓
保存代码 / 点 Refresh → iframe full reload
  ↓
bridge 重新 install() → post('vg:ready')
  ↓ (parent 收到 vg:ready)
LivePreviewFrame 读 useAppStore.getState() 发现 selection 还在
  ↓
iframe.contentWindow.postMessage({type:'vg:restore-selection', location:{file:relativeFile,line,column}}, expectedOrigin)
  ↓ (bridge 的 message listener, 0.2.0 新增 case)
findElementByLocation(location) 遍历 [data-code-agent-source] 匹配
  ├── 命中 → rotateClass HIGHLIGHT_CLASS + post('vg:select', extractInfo(...))
  │          → parent resolveAndSetSelectedElement 回写 appStore（幂等）
  └── 失败 → post('vg:selection-stale', {location})
             → parent setSelectedElement(tabId, null) → UI 回未选中态
```

覆盖范围：完整 full-reload（多数 HMR、手动 Refresh、URL 切换）。Partial HMR 下 DOM 原地替换的 case 暂不覆盖（需 DOM MutationObserver，留未来）。

#### 关键实现坑

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| iframe Refresh double-load | 蓝框偶尔不恢复（时好时坏） | `<iframe src={devServerUrl}>` 受控 prop，`iframeRef.current.src = '?_refresh=xxx'` 直接 mutate DOM 会被 React rerender 矫正回原 URL，实际加载两次、contentWindow 换两次 | 用 `refreshNonce` React state + `useMemo` 推 `iframeSrc`，`<iframe src={iframeSrc}>` 纯受控，单次 load |
| about:blank CSP 踩坑 | 老 handleRefresh 走 `src='about:blank' → rAF → src=原 URL`，Tauri WKWebView 下 frame-src CSP 对 about:blank 不稳定，且 about:blank 秒加载先触发 onLoad 误导 3s 诊断 timer | 中转态引入时序 race | 一次性 cache-bust query `?_refresh=${Date.now()}`，无中转 |
| SERVER_AUTH_TOKEN 不跨 restart | dev 下 kill/restart webServer 后 Tauri WebView 里固化的老 token 立刻失效，踩 "Invalid auth token" | `auth.ts` 每次启动 `randomUUID()` 生成新 token | `loadOrGenerateAuthToken()` 启动时先读 `.dev-token`，是合法 UUID v4 就复用；shutdown 不再 unlink `.dev-token` |
| Tauri 启动白屏 | `cargo tauri dev` 窗口可见但白屏 | `tauri.conf.json` 里 `window.url = "http://localhost:8180"` 硬编码，webview 一创建就请求；beforeDevCommand 还在 build（12s+），webServer 未监听，webview 加载失败进 error 页 | `window.url = "about:blank"`；Rust setup() healthcheck 通过后用 `webview.navigate(Url)` 跳 SERVER_URL，比 eval+JS 可靠 |
| workspace:setCurrent 不同步 renderer | 直接调 domainAPI setCurrent 后 appStore.workingDirectory 还是 null，LivePreviewFrame 的 resolveSourceLocation 走 `process.cwd()` fallback 丢 selected 条 | 原 `handleSetCurrent` 只更新 main 进程 state 不 emit event | 新增 `WORKSPACE_CURRENT_CHANGED` IPC 事件通道，main emit + renderer `sessionStore` 订阅调 `useAppStore.setWorkingDirectory` |

#### 改动文件索引

| 模块 | 文件 | 作用 |
|---|---|---|
| Bridge 协议 | `~/Downloads/ai/vite-plugin-code-agent-bridge/src/protocol.ts` `runtime.ts` | v0.2.0 新增 restore-selection / selection-stale + findElementByLocation |
| Shared 协议 | `src/shared/livePreview/protocol.ts` | 主仓库侧协议同步到 v0.2.0 |
| Shared envelope | `src/shared/contract/conversationEnvelope.ts` | `ConversationEnvelopeContext.livePreviewSelection?` |
| Shared IPC | `src/shared/ipc/legacy-channels.ts` `handlers.ts` | `WORKSPACE_CURRENT_CHANGED` 通道 + IpcEventHandlers 注册 |
| Main IPC | `src/main/ipc/workspace.ipc.ts` | handleSetCurrent 广播 WORKSPACE_CURRENT_CHANGED |
| Main auth | `src/web/middleware/auth.ts` `src/web/webServer.ts` | `.dev-token` 复用 + shutdown 不清 |
| Tauri | `src-tauri/tauri.conf.json` `src-tauri/src/main.rs` | window.url = about:blank + setup navigate(Url) |
| UI 入口（历史） | `src/renderer/components/features/chat/ChatInput/AbilityMenu.tsx` | 2026-04-24 的 Live Preview URL input + Open 按钮；2026-04-26 B+ 后迁到 `SessionActionsMenu` / `DevServerLauncher` |
| UI 预览面板 | `src/renderer/components/LivePreview/LivePreviewFrame.tsx` | bridge message handler + restore 发起 + stale 清理 + 诊断 |
| Store | `src/renderer/stores/appStore.ts` | `LivePreviewSelectedElement.relativeFile` |
| Composer | `src/renderer/stores/composerStore.ts` | `buildContext()` 读活动 tab 的 selection 并拍回协议 nested 形 |
| Session subscribe | `src/renderer/stores/sessionStore.ts` | 订阅 WORKSPACE_CURRENT_CHANGED |
| Tests | `tests/renderer/stores/composerStore.test.ts` | 覆盖三种 selection 场景（liveDev 有 / file tab / null） |

---

### v0.16.65+ 2026-04-26 实现回写

4 月 26 日这批提交没有 bump package version，但已经明显改变了稳定架构口径。当前要按 `v0.16.65+` 记录，而不是继续只停在 4 月 23 日的面板整合状态。

| 能力域 | 当前状态 | 关键落点 |
|---|---|---|
| Workbench B+ 信息架构 | ChatInput 移除 AbilityMenu；低频动作收进 `+`；Code/Plan/Ask 收进 `+` 菜单；模型和 effort 合并成单胶囊；Routing / Browser 归入 Settings 的“对话”tab；Settings 分组导航与页面骨架落地；TitleBar 只保留核心入口，全局工具移入 Sidebar User Menu | `ChatInput/InputAddMenu.tsx`、`ConversationSettings.tsx`、`SettingsModal.tsx`、`SettingsLayout.tsx`、`settingsTabs.ts`、`SessionActionsMenu.tsx`、`Sidebar.tsx`、`WorkbenchTabs.tsx` |
| Live Preview V2-A/B | `devServerManager` 能探测并启动本地 dev server，DevServerLauncher 作为模态入口；bridge protocol 升级到 0.3.0，选中元素带 `className` 与 `computedStyle`；TweakPanel 支持 spacing/color/fontSize/radius/align 5 类 Tailwind 原子改写；V2-C Next.js App Router 支持按 ADR-012 延期 | `devServerManager.ts`、`LivePreviewFrame.tsx`、`TweakPanel.tsx`、`tweakWriter.ts`、`tailwindCategories.ts`、`docs/decisions/012-live-preview-v2-c-deferred.md` |
| Browser / Computer Workbench | in-app managed browser 已从 smoke 级推进到生产化基线：BrowserSession/Profile/AccountState/Artifact/Lease/Proxy、TargetRef/stale recovery、download/upload、fixture-only recipe benchmark 全部有 acceptance；Computer Surface 增加 background AX 与 background CGEvent 两条受控验证路径 | `browserService.ts`、`browserProvider.ts`、`browserAction.ts`、`computerUse.ts`、`desktop.ts`、`docs/acceptance/browser-computer-workbench-smoke.md` |
| Activity Providers | OpenChronicle 与 Tauri Native Desktop 不再各自直塞 prompt；新增 provider-neutral `ActivityContextProvider`、`ActivityProvider` contract、prompt formatter 与 renderer preview。OpenChronicle 仍是外部 daemon provider，Tauri Native Desktop 是 bundled provider | `activityContextProvider.ts`、`activityProviderRegistry.ts`、`activityPromptFormatter.ts`、`activityContext.ts`、`activityProvider.ts` |
| Semantic Tool UI | 工具 input schema 强制注入 `_meta.shortDescription`；provider parser 抽出 `_meta` 写到 ToolCall 顶层并剥离执行参数；SessionRepository 对无 `_meta` 的历史/弱模型工具调用生成 fallback shortDescription。前端用语义标题、target icon、memory citation 折叠卡、会话 diff 聚合卡和 URL favicon chip 改善可读性 | `prompts/builder.ts`、`model/providers/shared.ts`、`SessionRepository.ts`、`ToolHeader.tsx`、`MemoryCitationGroup.tsx`、`SessionDiffSummary.tsx`、`LinkPreviewCard.tsx` |
| Eval / model 协议修复 | 评测实验支持 SSE 进度、行点击进详情、fatal inference error 熔断、DB 去重；multi-turn adapter 真保留 messages；recent memory 在评测中隔离；thinking-mode provider 补齐 `reasoning_content` history 字段；`max_tool_calls` 从 critical gate 降为 weighted score | `testRunner.ts`、`agentAdapter.ts`、`retryStrategy.ts`、`providers/shared.ts`、`docs/knowledge/eval-tracking.md`、`docs/knowledge/bug-fixes.md` |

#### Live Preview V2 当前边界

V2 的稳定口径是 **Vite-only MVP**：自动起 dev server + 点击源码定位 + TweakPanel 原子样式修改。Next.js App Router 不计入 V2 完成定义，原因见 ADR-012。后续若 React / Next / SWC 生态出现可复用方案，再重新评估 V3。

#### Browser / Computer 当前边界

Browser 主路径是 in-app managed browser，默认验收走 System Chrome headless + CDP。远程浏览器池、外部 Chrome profile、外部 CDP attach、extension bridge 仍保留为 backlog，不写成当前已完成。Computer Surface 的 background AX / CGEvent 只对显式 target app/window 和本地受控 smoke 成立，foreground fallback 仍是需要人工确认的当前前台动作面。

---

## 平台架构（三端产品）

项目基于 Tauri 2.x，扩展为三端产品：

```
┌─ Web 端（浏览器）─────────────────────────────┐
│  React 18 + Vite                              │
│  ├── 云端功能 → webServer API                  │
│  └── 本地功能 → Bridge (localhost:9527)         │
└───────────────────────────────────────────────┘
┌─ App 端（Tauri 2.x）─────────────────────────┐
│  Rust Shell → spawn Node.js webServer         │
│  ├── tauri-plugin-updater 原生自动更新          │
│  ├── Tauri 2.x capabilities 权限模型           │
│  └── 完整本地能力（文件/Shell/进程）             │
└───────────────────────────────────────────────┘
┌─ CLI 端 ─────────────────────────────────────┐
│  Node.js 单文件 (esbuild)                     │
│  ├── 5 模式: chat / run / serve / exec / mcp  │
│  ├── 复用 AgentLoop + ToolRegistry            │
│  └── npm install -g code-agent-cli             │
└───────────────────────────────────────────────┘
```

| 端 | 定位 | 代码入口 |
|----|------|----------|
| Web | 尝鲜体验，浏览器即用 | `src/web/webServer.ts` |
| App (Tauri) | 主力体验，完整本地能力 | `src-tauri/` + `src/main/platform/` |
| CLI | 极客/Agent 调用/MCP Server | `src/cli/index.ts`（[详细架构](./architecture/cli.md)）|

### 平台抽象层 (`src/main/platform/`)

v0.16.44+ 引入平台抽象层，统一封装 Tauri/Electron/Web 的差异 API（窗口管理、路径、剪贴板、Shell、通知、全局快捷键、IPC 注册），业务代码不再直接导入 Electron 或 `@tauri-apps/*`。

关键技术决策：
- **Tauri 2.x 替代 Electron**：DMG 从 742MB → 33MB（95% 缩减）
- **Rust shell 启动 Node.js webServer 子进程**，health check 检测开发模式
- **CSP 安全策略 + capabilities 权限模型**

---

## 2026-05-29 ~ 05-30 新增模块 — Dynamic Workflow（命令式脚本编排）+ Model Selector 重构 + Per-provider Runtime + Fleet Observability

> 版本号仍 `0.16.88`（dynamic-workflow feature 线一次性 push origin/main，未单独 bump）。

### M1: Dynamic Workflow — 命令式脚本编排运行时（主线）

在既有「声明式 stage-DAG」（`workflow_orchestrate`）之外，新增**第 4 条多 Agent 路径**：模型当场写 JS 编排脚本 → 受限 worker_threads 沙箱后台确定性执行，扇出几十上百子 agent 做对抗验证 / 流水线 / resumable 调研。复刻 Claude Code Workflow，P1→P4 四阶段（运行时核心 / token budget + 工具档 / UI 进度树+审批+触发 / resumable 源码重放），每阶段 Codex 4 轮对抗审计收敛。

- **原语**：`agent/parallel/pipeline/phase/log` + `args`/`budget`。`agent({schema})`=单轮 forced tool_choice（命令式控制流的稳定判断值地基），无 schema=完整 SubagentExecutor loop。
- **隔离**：runService 多 run 隔离（破 swarm 单 active-run 假设）+ agent() 直连 executor 绕 4 条灌历史高层入口（中间结果不进主 context）+ provider-aware 全局并发闸（防 zhipu/3 饿死）。
- **resumable**：源码重放 + agent 结果缓存（不序列化 VM 状态），专用表 `workflow_runs`/`workflow_run_calls`，命中 0 token。
- **安全**：威胁模型半信任模型代码；已知缺口 = worker `AsyncFunction` 字符串求值逃逸，`isolated-vm` 硬沙箱排后。

完整设计见 **[architecture/dynamic-workflow.md](./architecture/dynamic-workflow.md)**；多路径对照见 [multiagent-system.md §0.0.4](./architecture/multiagent-system.md)；journal 表见 [data-storage.md](./architecture/data-storage.md)；IPC 见 [ipc-channels.md](./architecture/ipc-channels.md)。

### M2: Model Selector 层级重构（`feat(model): restructure selector hierarchy`）

StatusBar `ModelSwitcher` 重构为层级化选择器（provider → 模型族 → 模型），抽出 `modelSwitcherHelpers.tsx` + `providerLogoCatalog.ts`；`contextAssembly/inference.ts` 拆出 `effortControls.ts` / `visionPreflight.ts` / `artifactRepairRetryMessages.ts` 三个职责模块。配套 `fix: scope discovered provider models by family`——discover 出的 provider 模型按模型族归类，避免跨族串号（`provider.ipc.ts`）。

### M3: Per-provider Runtime Helpers 拆分（`refactor: split runtime provider helpers`）

把 provider 连通性测试与运行时 helper 从 `model/providers/shared.ts` / `provider.ipc.ts` 抽到 `model/providerConnectionTest.ts` + `model/providers/providerRuntime.ts`，瘦身 `contextAssembly.ts`（120→精简）。属内部重构，不改对外语义。

### M4: Fleet Observability 管理面扩展（`feat: extend fleet observability admin console`）

`admin-console/` 扩展：新增 errors / feedback 页、session 详情页、Sentry 接入（`lib/sentry.ts` + `src/main/observability/sentryNode.ts`）、PostHog dashboards 与 live-event smoke 脚本。详见 [observability.md](./architecture/observability.md) 与 `docs/plans/2026-05-28-fleet-observability-plan.md`。配套 `feat: improve cowork orchestration UX`——声明式 `workflow_orchestrate` 的 telemetry / 编排体验增强（与命令式 M1 不同路径）。

---

## v0.16.88 新增模块 — AI SDK 全量收口 + Light Memory 质量闭环 + MCP 只读边界 + Alma 渲染（2026-05-26 ~ 05-27）

接 v0.16.80，本轮把上一轮起的几条线收口并新开两条：把全部 provider 迁到 AI SDK（消灭"双引擎里仍有 provider 走旧路径"的尾巴）、给 Light Memory 加写入端判定 + 周期整理的质量闭环、对外 MCP server 定调"控屏永不暴露"、按 alma 思路重做聊天渲染与应用内导航。

### W1: AI SDK provider 全量迁移收口

**M1 双引擎已就地更新到 as-built**（见上文 v0.16.80 M1 表的「引擎开关 / provider 路由」行 + 收口效果注）。要点：gemini+openrouter 迁官方包（`@ai-sdk/google` / `@openrouter/ai-sdk-provider`），zhipu/moonshot/xiaomi 迁 `@ai-sdk/openai-compatible` + `buildVendorCompatSettings()`，`AISDK_UNSUPPORTED_PROVIDERS` 清空 → 所有 provider 都走 AI SDK，旧手写层仅 `=legacy` 保留待 P3 净删。完整 as-built 见 [migration §7](./architecture/ai-sdk-provider-migration.md)。

### W2: Light Memory 质量闭环（WS4）

Light Memory 是 Neo 唯一的跨会话记忆系统（File-as-Memory，`~/.code-agent/memory/` Markdown + INDEX.md，见上文「轻量记忆系统」小节）。本轮给它加写入端与整理端两个质量环节，落点已并入该小节表格（会话判定 / 记忆整理 / 整理 cron）。

| 环节 | 做什么 | 关键设计 |
|------|--------|----------|
| **WS4-A 写入端** | `runFinalizer` → `conversationJudge` 用 quick model 判会话是否值得记 + 抽 title/知识点 | 过滤"hi/ok/继续"类无价值会话；async fire-and-forget 不阻塞收尾；失败回退启发式，永不丢摘要 |
| **WS4-B 整理端** | 周一 04:00 cron 跑 `consolidation`：gate 判定 → quick model 合并计划 → 落盘 + 重建 INDEX | gate 健康时零 token（INDEX≤200 行/无重复/文件<40 直接跳过）；信息无损 guard 拒绝孤立删除（裸删=丢信息）；默认 dry-run 验证后再真写 |

> 设计文档 [ws4-memory-consolidation.md](./designs/ws4-memory-consolidation.md)，as-built 与设计零偏差。

### W3: MCP 只读安全边界（WS5）

Neo 作为 MCP server 对外暴露能力时，**控屏/写入类能力永不通过 MCP 暴露**（与上文 2026-05-13 "Computer-use MCP 入口归位"区分：那是 Neo 把 Computer 包成 native ToolModule 给**自己**用；WS5 是 Neo **对外**作为 MCP server）。

| 阶段 | 做什么 | 落点 |
|------|--------|------|
| **WS5a 止血** | 给 `computer`/`execute_command`/`clear_logs` 加 opt-in 闸 + env flag（默认关），新增 `eval-query`/`appshots-query` 只读工具 | `src/main/mcp/mcpServer.ts`（commit `e281196c`） |
| **WS5b 定调** | 评估后**否决**门控方案——stdio MCP 无法可信认证 caller（无 mTLS/OAuth），5 层授权门复杂度失衡 → **彻底移除**三个控屏工具及全部 gate 代码 | `mcpServer.ts` 从 ~229 行收敛为只读不变量（commit `8c85ac22`） |

当前 MCP server 仅暴露 5 个只读工具：`get_logs` / `get_status` / `screenshot`（读屏不控屏）/ `eval-query` / `appshots-query`。强制方式 = 直接不定义 control 工具，调未定义工具返回 `Unknown tool`。正确的控屏路径是 **Neo 作为 orchestrator 编排外部 agent**，不是外部反向控制 Neo。详见 [MCP_SERVER.md 安全边界](./MCP_SERVER.md) + [ws5b 决策](./designs/ws5b-computeruse-mcp-security.md)。

### W4: Alma 式聊天渲染 + neo:// 深链 + Computer-use PiP（前端）

借鉴 alma 重做聊天主链路的渲染顺序、流式观感、应用内导航和控屏可视化。完整落点见 [frontend.md「2026-05-26~27 增量」](./architecture/frontend.md)。要点：

- **`contentParts` 交错渲染**（`AssistantMessage.tsx`）：按服务端 contentParts 原序交错渲染正文与工具调用，修复 WebSearch 折叠块顺序倒置。
- **流式动效 + 安静思考态**（`global.css` + `StreamingIndicator.tsx`）：淡入上浮 + 呼吸光标，工具 45s+ 才升级警示，健康长生成不告警。
- **neo:// 深链卡片（WS2 / IACT）**（`MessageContent.tsx` `IACTNavCard` + `identity.ts`）：模型回答里给可点击的会话切换/设置跳转卡片，react-markdown urlTransform 白名单放行 `neo://`。
- **Computer-use PiP（WS3）**（`src-tauri/src/pip.rs` + `useComputerUsePip.ts`）：控屏时弹画中画窗口实时展示截图帧流。
- 另含聊天内联图表（` ```json` 命中 spec 也渲为图表）、回到底部浮按、Tauri 下外链可点击。

---

## v0.16.80 新增模块 — Goal Mode 三层闸 + AI SDK 双引擎 + Appshots + OS 沙箱（2026-05-22 ~ 05-26）

接 v0.16.79，本轮四条线并行：把 provider 矩阵迁到 Vercel AI SDK（双引擎、可一键回退）、上线 `/goal` 自治目标循环（完成判定权落代码层的三层闸）、新增 Appshots（左右 Command 双击截当前窗口注入多模态上下文）、给最危险的 `bypassPermissions` 档接 OS 级沙箱兜底。

### M1: Provider 层迁移到 Vercel AI SDK（双引擎）

详见 [Provider 层迁移设计](./architecture/ai-sdk-provider-migration.md)（本地设计稿）。已 merge：PR #164（子代理）/ #165（主 loop）/ #168（regression 收尾）。

| 模块 | 位置 | 描述 |
|------|------|------|
| **AiSdkModelAdapter** | `src/main/model/adapters/aiSdkAdapter.ts` | 实现现有 `ModelRouter.inference` 契约。`generateText`（非流式，服务子代理 + artifact 重试）+ `streamText`（流式，主 loop，`fullStream` 映射成项目 StreamChunk 契约）；`tool()` 只取 schema，执行仍走 Neo 自己的 toolExecutor + 权限/审计/hook |
| **引擎开关** | `CODE_AGENT_MODEL_ENGINE` flag | 子代理 + 主 loop 默认 aisdk（`!== 'legacy'`），`=legacy` 一键全回退旧 modelRouter；`AISDK_UNSUPPORTED_PROVIDERS` 已清空（2026-05-27 收口），**所有 provider 都走 AI SDK，不再有自动降级**，该集合留待 P3 净删旧路径时一并删除 |
| **provider 路由** | `aiSdkAdapter.resolveModel()` + `providerResolution.ts` | 按 provider 选包：deepseek→`@ai-sdk/deepseek`、anthropic→`@ai-sdk/anthropic`、gemini→`@ai-sdk/google`、openrouter→`@openrouter/ai-sdk-provider`、其余（zhipu/moonshot/xiaomi/longcat/qwen/…）→`@ai-sdk/openai-compatible` + `buildVendorCompatSettings()`（thinking 字段/采样参数）。baseURL/apiKey 仍由 `providerResolution.ts` 收口（zhipu 三态 / moonshot 专端点 / `resolveProviderApiKey(trustConfigKey)` 区分主 loop vs 子代理）；zhipu 免费档并发 limiter 套在 `inferenceViaAiSdk()` 外层 |
| **消息归一** | `aiSdkAdapter.toAiMessages` + `reorderToolResultsAfterAssistant` | Neo ModelMessage ↔ AI SDK ModelMessage；镜像旧路径 `sanitizeToolCallOrder` 把夹在 assistant tool-call 与 tool-result 之间的 system 消息后移（否则 AI SDK 校验抛 `MissingToolResultsError`） |
| **瞬态重试** | `withTransientRetry` + `emittedOutput` 闸门 | adapter `maxRetries:0` 交项目统一策略（网络 + HTTP 瞬态都覆盖）；流式仅"首个可见 delta 之前"的瞬态失败才重试，已吐字后绝不重试 |

> 收口效果：从根上消灭"流式/非流式两套解析不对称"的整类 bug（DeepSeek 非流式把 tool call 吐成 `<｜｜DSML｜｜>` 文本漏调用等）；新接模型不再要写一批 per-model 解析分支 + 隐藏 bug。
>
> **全量收口（2026-05-27，WS1 Phase 1-2，commit `8479276d` / `85bc4ac2`）**：gemini+openrouter 迁官方包（`@ai-sdk/google` / `@openrouter/ai-sdk-provider`）、zhipu/moonshot/xiaomi 迁 `@ai-sdk/openai-compatible`，`AISDK_UNSUPPORTED_PROVIDERS` 清空——全 provider 走 AI SDK。旧手写层（`BaseOpenAIProvider`/`openaiWrapper`/`sseStream`）仅 legacy 引擎保留，待 P3 净删。详见 [migration §7](./architecture/ai-sdk-provider-migration.md)。

### M2: Goal Mode — `/goal` 自治目标循环（三层闸）

详见 [/goal 模式设计](./designs/goal-mode.md)。核心论点：完成判定权从 prompt 层提升到**代码层**，模型调 `attempt_completion` 只是"申请退出"，绕不过闸。

| 模块 | 位置 | 描述 |
|------|------|------|
| **闸编排** | `src/main/agent/goalModeController.ts` | GoalContract / buildGoalContract（verify 与 review 二选一）/ 闸3 evaluateFallback（token budget · max-turns · 连续无进展）/ continuation + Codex 式 audit nudge / recordTurnProgress |
| **闸1（硬·确定性）** | `src/main/agent/goalVerifyGate.ts` | `runVerifyGate()` 直接 `/bin/sh -c` exec `--verify` 命令 parse 退出码——**不经 LLM**，绕开"对话不可信" |
| **闸2（软·可选）** | `src/main/agent/goalReviewGate.ts` | `runReviewGate()` 派 `goal-review` 子代理（`powerful` tier，带 read/grep/glob/ls），parse 末行 `VERDICT: PASS\|FAIL` |
| **完成申请** | `attempt_completion` 工具 + `messageProcessor` 拦截 | goal-mode 才预加载暴露；调用即触发三层闸，模型无法自称完成直接退出 |
| **循环改造** | `src/main/agent/runtime/conversationRuntime.ts` | text-stop `break` → goal-mode `continue`（注续跑提示/审计 nudge）；loop-top 每轮跑闸3 |
| **SSE + UI** | `src/shared/contract/agent.ts` + renderer | `goal_iteration` / `goal_gate` / `goal_complete{status}`；`/goal` 斜杠命令 + `GoalStatusBar` 实时状态条 + `GoalNoticeMessage` 生命周期卡片；桌面 IPC + headless REST 双链路 |

### M3: Appshots — 窗口快照 → 多模态上下文（macOS）

详见 [Appshots 设计](./designs/appshots.md)。Phase 1-4 全部已并 main（含 Phase 3.1 多屏 / 4a 设置 UI / 4b OCR 预编译二进制）。

| 模块 | 位置 | 描述 |
|------|------|------|
| **原生核心** | `src-tauri/src/appshots.rs` | `CGEventTap` listen-only 监听左+右 Command 双击；NSWorkspace+CGWindowList 定位前台窗口（PID+bundleId 排除自身）；`screencapture -l` 窗口截图；AX 无障碍树取文本，端上 Vision OCR 兜底；透明 overlay 飞入动画；`APPSHOTS_ENABLED` 门控 |
| **契约** | `src/shared/contract/appshot.ts` | `buildAppshotXml`（隐藏 `<appshot>` 注入，避开 @mention）/ `stripAppshotBlocks`（对用户隐藏对模型可见）/ `buildAppshotAttachment`（图片附件） |
| **前端** | `appshotsStore.ts` / `useAppshots.ts` / `AppshotChip.tsx` | 事件（`appshots:capture_starting\|ready\|error`）→ store（`startingSessionId` 防串台）→ chip（缩略图 + 文本来源标签 + 预览 Modal）→ 发送注入 |

> 与 Connector / MCP 的区别：Appshots 不是模型可调能力，而是**用户热键触发、把上下文注入输入框**的原生输入增强（见 [Native App 集成](./architecture/native-app-integration.md) 的能力分类）。

### M4: bypassPermissions 档接入 OS 级沙箱

详见 [OS 沙箱接入方案](./plans/2026-05-25-os-sandbox-bypass-mode-plan.md)。只给最危险的 YOLO 档加内核级 blast-radius 兜底，其余权限档行为零变化。

| 模块 | 位置 | 描述 |
|------|------|------|
| **沙箱实现** | `src/main/sandbox/{seatbelt,bubblewrap,manager}.ts` | macOS `sandbox-exec` + `generateProfile()` / Linux `bwrap` / 统一 `SandboxManager`（原为零调用死代码，本轮接线） |
| **命令包装接线** | `src/main/tools/modules/shell/bash.ts` + `wrapCommand` API | 仅 `bypassPermissions` 档：把命令前缀包装成 `sandbox-exec -f <profile> /bin/sh -c "<cmd>"` 喂回原 `runForegroundCommand`（流式/中断/错误语义白嫖，不用缓冲式 `executeInSandbox`） |
| **fail-fast** | bash.ts 模式判定 | 沙箱不可用 → 硬报错 `SANDBOX_UNAVAILABLE` 拒绝执行，**绝不静默裸跑降级** |
| **门控** | `SANDBOX.OS_SANDBOX_ENABLED`（constants.ts） | 默认关 + env 启用（沿用 `CODEX_SANDBOX` 惯例）；profile=allow-default + 锁写、subpath 须 realpath |

> 顺带：node-pty `spawn-helper` 执行位经 `postinstall` 恢复（资源扫描 EACCES / PTY 起不来）。

### M5: 附件管线 v2 — 多类型附件 → 端侧摘要 → 模型上下文（迭代追加，🚧 wip）

详见 [附件管线 v2 设计](./designs/attachments.md)。本轮 commit `162f54f5` 在 v0.16.80 之后追加（来自验收迭代，**未经逐行 review，待后续处理**）。核心思路：**重二进制在端侧提炼成轻量摘要，本体既不喂模型也不写库**。

| 模块 | 位置 | 描述 |
|------|------|------|
| **契约扩类** | `src/shared/contract/message.ts` | `category` 补 `audio`/`video`/`presentation`/`archive`（`document` 收窄为 DOCX）；新增 `PresentationSummary` / `ArchiveManifest` 类型 + 附件字段 `pptJson` / `archiveManifest` |
| **端侧摘要** | `src/renderer/.../ChatInput/attachmentSummaries.ts` | 上传时 `jszip` 解 PPTX 逐页取文字/图/表（≤20 页）、解 ZIP 出目录清单（≤200 条 + zip-slip 危险路径检测）；**不自动解压**，仅产摘要 |
| **模型序列化** | `src/main/agent/messageHandling/converter.ts` | `buildMultimodalContent` 新增 audio/video/presentation/archive 分支：渲染元数据/摘要 + 工具引导（PPT 引导走 `ppt_edit analyze`）；`canProcessAttachmentWithoutData` 准入闸 |
| **strip + 瘦身** | `src/shared/utils/messageAttachments.ts` | `stripInlineAttachmentBlocks`（`<attachment>` 对用户隐藏、对模型可见，镜像 Appshots）；`sanitizeAttachmentsForPersistence`（入库前剥离非图片大 data URL，只留摘要） |
| **持久化接线** | `SessionRepository.ts` / `web/{routes/agent,helpers/sessionCache}.ts` | desktop + web 双链路统一在持久化边界 strip content + sanitize attachments，行为对齐 |

---

## v0.16.76-79 新增模块 — 插件化 / 能力路由 / 死代码瘦身 / 依赖大版本（2026-05-19 ~ 05-21）

接 v0.16.75 的 Agent Neo 管理面，本轮三天 50 commits 集中在：把多模态/桌面能力剥成 builtin plugin（PluginAPI v2）、Marvis 风格的能力路由、删 evaluation 子系统死代码、quick model 路径修复、工具失败输出对模型可见、依赖统一升大版本、release 签名/公证管线收口。

### M1: 插件化重构 — PluginAPI v2 + 7 个 builtin plugins

详见 [插件系统架构](./architecture/plugin-system.md) 与 [ADR-017](./decisions/017-plugin-boundary-three-layers.md)。

| 模块 | 位置 | 描述 |
|------|------|------|
| **PluginAPI v2** | `src/main/plugins/types.ts`、`pluginRegistry.ts` | `pluginApiVersion: 2`；新增 `getApiKey`（15 provider 白名单 ReadonlySet runtime 校验）/ `getCurrentUser`（`{id,isAdmin}` + admin trust-gate）/ `getConstants`（models·providers·pricing·timeouts 4 桶双层 freeze，过滤内部代理 URL）/ `registerToolModule`（ToolModule 协议 + emit + artifact） |
| **Builtin Loader** | `pluginRegistry.loadBuiltinPlugins()` | `initialize()` 静态 import 7 个 builtin manifest+entry，esbuild tree-shake 到 host 同 bundle；第三方磁盘加载链路（discover/load/watch）原样保留 |
| **7 个 builtin plugins** | `src/main/plugins/builtin/*` | imageProcess / audioProcessing / videoGeneration / imageCreation / browserControl / computerUse / photoArchive 从 `tools/modules/` 剥离；builtin 用 `prefixWithPluginId: false` 保留原工具名，executionPhase / deferredTools / prompt / cache / eval baseline 零改动 |
| **Plugin 化边界 (ADR-017)** | `docs/decisions/017-plugin-boundary-three-layers.md` | 11 个难剥 service 按性质分三层 RED：Prompt Context Contributors（9 个，注入 system prompt）/ Runtime Planning State（plan/task 控制状态，留 core）/ Assembly Policy（context pressure + token 预算，留 core），防"按不能 plugin 化命名的层"沦为垃圾桶 |
| **desktop facade 收口** | `src/main/desktop/desktopContextBridge.ts` | `bootstrapDesktopTurnContext` 高层入口聚合 desktop turn 状态同步（todo/task/planning/workspace/recovery）；`conversationRuntime` 删 3 处 desktop 直接 import，`bootstrapDesktopDerivedContext` ~165→~70 行，只留 Assembly Policy 层 |
| **管理员插件管理** | renderer settings + extension 路由 | admin plugin management settings 暴露；plugin slash command 走 extension 路由；verified auth 后保留 admin profile |

### M2: Marvis 风格能力路由 + Capability Center 增强

| 模块 | 位置 | 描述 |
|------|------|------|
| **Routing assessments** | `src/main/services/capabilities/capabilityAssessment.ts` | Marvis 启发的能力对照/路由评估（接 f2845554 的能力对照补齐） |
| **Chat capability triggers** | `CapabilitySuggestionStrip.tsx`、`CapabilityRecommender.ts`、`sessionSkillService.ts` | 聊天输入区按上下文浮出能力建议条；`/tools` 命令树扩展（+284 行）；推荐进 SlashCommandPopover / InlineWorkbenchBar |

### M3: 死代码瘦身 — 删 evaluation 子系统（-20K 行）

社区调研：8 个主流 code agent（Aider/Cursor/Cline/Continue/Claude Code/Codex/Devin/Cody）无一把 per-session grader + 失败漏斗 + 实验跟踪做成用户功能；本项目 `evaluations` 表 29 条记录、最后写入停在 2026-03-09，典型 over-engineered dogfood 失败。

| 动作 | 范围 |
|------|------|
| **删 UI** | evalCenter 整套（renderer 43 文件）+ `src/main/evaluation/` 17 文件 + 4 子目录 |
| **删 IPC / 契约** | `evaluation.ipc.ts` + 36 个 `EVALUATION_*` channel + `evaluationFramework` / `previewFeedback` contract；WorkspacePreviewPanel 内嵌的 delivery review + preview feedback |
| **删 DB** | drop `evaluations` / `eval_snapshots` / `review_queue_items` / `review_queue_failure_assets` / `preview_feedback_items` 共 5 表 + 3 索引 |
| **保活路径** | `trajectory/` + `replayService` + `telemetryQueryService` + `transcriptReplayBuilder` + `experimentAdapter` + `sessionEventService`（telemetry IPC / agentOrchestrator / bug-report replay 仍依赖）；DB 保 `experiments` / `experiment_cases` / `session_events` / `telemetry_*` |

### M4: 模型路由 — quick model 修复

| 模块 | 位置 | 描述 |
|------|------|------|
| **Provider 并发限流** | `src/main/model/concurrencyLimiter.ts` | 通用 `ConcurrencyLimiter` + `getProviderLimiter`，`PROVIDER_CONCURRENCY_LIMITS={zhipu:{3,200ms}}`；主模型路径与 quick model 路径共用同一 provider 限流器，quickTask 不再裸 fetch 绕过节流打爆智谱免费档 |
| **quickModel 策略化** | quick model 解析路径 | 优先 `routing.fast` → 无 key 回落 `routing.code` 主模型并对 reasoning 模型注入 `thinking:{type:'disabled'}`（否则思考模型短输出被 reasoning 吃光返回空）→ 兜底 env → null |
| **默认 quick model** | `DEFAULT_MODELS.quick` | `glm-4.7-flash`（27-40s 思考模型，撑不住 3s intent 分类）→ `glm-4-flash`（实测 0.7s，非 thinking）；完整加进注册表/pricing/context-window/features/abbrev |

> 验证：真实 API 12 并发 quickTask 从 2×429 + 10 空 + 178s → 12/12 成功 0×429 3.7s。

### M5: 工具失败输出对模型可见（自纠错修复）

`messageProcessor` 取 `output||error`，不读 `meta.output`。命令失败时输出被塞进 `meta.output`，模型只看到 `exit code N` 看不到真因，被迫用 `2>&1; echo $?` 骗成 exit 0 才能看到错误，表现为对同一命令反复重试（实测某 case 跑 5 次）。

| 入口 | 文件 |
|------|------|
| Bash 前台 / PTY | `src/main/tools/modules/shell/bash.ts` |
| 子 agent task | `src/main/tools/modules/multiagent/task.ts` |
| explore 子 agent | `src/main/tools/modules/planning/explore.ts` |

改为把失败输出折进模型可见 `error` 字段（加截断防超长），`meta.output` 保留供 telemetry/artifact；abort（用户主动取消）保持干净不动。业界参考一致：Anthropic computer-use `bash.py` 与 OpenAI Codex 在任何退出码下都把 stdout+stderr 返给模型——藏掉失败输出会废掉 agent loop 的自纠错。

### M6: 依赖大版本升级 + release 管线

| 项 | 内容 |
|----|------|
| **工具链** | TypeScript 6 / ESLint 10 / Vite 8(Rolldown) / better-sqlite3 12 / commander 14 / glob 13 / marked 18 / pptxgenjs 4 等 ~25 个大版本 |
| **运行时** | React 18→19、zod 3→4、openai 4→6、Tailwind 3→4；Rust 侧 `cargo update`（Tauri 仍 2.x）；`.node-version` / `engines.node` 锁 node 24，根治多版本 Node 下 better-sqlite3 ABI 错配 |
| **适配** | React19 useRef 初值、zod4 record/三泛型、vite8 manualChunks 函数式、Tailwind4 `@utility` + outline-hidden（95 处）、pptxgenjs4 require.resolve 反推包根 |
| **release 管线** | dmg 装到 /Applications 后单独 `xcrun stapler staple`；repack tar.gz + upload；vision-tagger / vision-ocr Swift 工具签名；CI 自动 push Supabase migrations；版本 → v0.16.79 |

---

## v0.16.57 新增模块 — 架构对齐（2026-04-01）

对标成熟 code agent 能力拆解包，4 个里程碑 21 个 task 完成核心路径架构对齐。

### M1: 上下文投影系统（Projection-First Context Management）

| 模块 | 位置 | 描述 |
|------|------|------|
| **精确 Token 计数** | `src/main/context/tokenEstimator.ts` | 从字符比例启发式（误差 10-30%）升级为 BPE 实测（gpt-tokenizer，误差 <1%） |
| **CompressionState** | `src/main/context/compressionState.ts` | 不可变 commit log + snapshot 双持久化，追踪所有压缩操作 |
| **ProjectionEngine** | `src/main/context/projectionEngine.ts` | 纯函数投影：transcript + compressionState → API 视图（transcript 永不修改） |
| **六层压缩管线** | `src/main/context/layers/` + `compressionPipeline.ts` | L1 tool-result budget → L2 snip → L3 microcompact → L4 contextCollapse → L5 autocompact → L6 overflow recovery |
| **多分支决策引擎** | `src/main/agent/loopDecision.ts` | 每轮显式决策 continue/compact/continuation/fallback/terminate，含 max_tokens 续写协议 |
| **错误分类器** | `src/main/model/errorClassifier.ts` | 6 类错误分类（overflow/rate_limit/auth/network/unavailable/unknown）驱动恢复决策 |
| **缓存稳定性** | `src/main/prompts/cacheBreakDetection.ts` | DYNAMIC_BOUNDARY_MARKER 切分可缓存前缀和动态段，跨轮缓存不失效 |
| **/context 命令** | `src/main/ipc/context.ipc.ts` + `ContextPanel.tsx` | 展示 API 真实视图（经投影后）、token 分布、压缩状态 |

**核心架构变更**：从"原地变异"升级为"投影优先"——原始 transcript 不可变，CompressionState 追踪操作，ProjectionEngine 在查询时生成模型实际看到的视图。

```
Transcript (append-only, immutable)
    ↓
CompressionState (commit log + snapshot)
    ↓ query-time projection
API View (model actually sees)
```

### M2: Prompt 矩阵 + 多 Agent 子运行时

| 模块 | 位置 | 描述 |
|------|------|------|
| **Overlay 引擎** | `src/main/prompts/overlayEngine.ts` | 5 层叠加（substrate → mode → memory → append → projection），每层独立可开关 |
| **Prompt Profile** | `src/main/prompts/profiles.ts` | 4 种入口 profile（interactive/oneshot/subagent/fork）各有独立 overlay 组合 |
| **子 Agent 上下文重建** | `src/main/agent/childContext.ts` | `buildChildContext()` 从父上下文派生完整子运行时（prompt/tools/permissions/hooks/memory） |
| **Agent Registry** | `src/main/agent/agentRegistry.ts` | 用户/项目 `.code-agent/agents/*.md` 与 builtin agent 合并；project > user > builtin；spawn、Task、CLI、@mention、StatusBar 共用 |
| **AgentTask 状态机** | `src/main/agent/agentTask.ts` | 7 态生命周期（pending→registered→running→stopped→resumed→failed→cancelled）+ transcript 持久化 |
| **Mailbox 协调** | `src/main/agent/mailboxBridge.ts` + `agentBus.ts` | worker↔leader 协调协议（permission_request/response、task_dispatch、status_report） |

### M3: 权限矩阵 + 事件分层 + 连续性协议

| 模块 | 位置 | 描述 |
|------|------|------|
| **GuardFabric** | `src/main/permissions/guardFabric.ts` | 多源竞争（Rules + Mode + Hooks + Classifier + UserConfigSource），deny > ask > allow，first-valid-wins |
| **拓扑感知** | guardFabric 内置 | main/async_agent/teammate/coordinator 各有不同裁决（async_agent+bash→deny） |
| **Subagent 权限继承** | `src/main/agent/childContext.ts` + `src/main/permissions/userConfigSource.ts` | 默认 `strict-inherit`；tools 交集、deny 并集、mode 取严；用户 deny/ask/allow 级联 |
| **事件三通道** | `src/main/events/internalEventStore.ts` + `controlStream.ts` | Internal（持久化 JSONL）+ Control（实时推送）+ Mailbox（agent 协调） |
| **EventReplay** | `src/main/events/eventReplay.ts` | 从 InternalEventStore 回放事件，支持 agentId/时间范围过滤 |
| **Worker Epoch** | `src/main/session/workerEpoch.ts` | 生成代围栏防止并发写入，`guardedWrite()` 校验 epoch 一致性 |
| **Rematerialization** | `src/main/session/workerEpoch.ts` | 从快照投影恢复（非 transcript 逐条回放），`checkResumeConsistency()` 一致性检查 |

### M4: 多模型路由整合 + Operator Surface（差异化增强）

| 模块 | 位置 | 描述 |
|------|------|------|
| **压缩模型路由** | `src/main/context/compressionModelRouter.ts` | L4→zhipu/glm-4-flash（最便宜），L5→moonshot/kimi-k2.5（更强摘要），L1-L3→null |
| **智能 Fallback** | `src/main/model/adaptiveRouter.ts` | `selectFallback()` 按失败原因选择：overflow→更大窗口，rate_limit→换 provider |
| **Agent 模型策略** | `src/main/agent/agentModelPolicy.ts` | 按 agent 类型分配模型（Explorer→Kimi 128k, Reviewer→DeepSeek R1, Search→Perplexity） |
| **请求规范化** | `src/main/model/middleware/requestNormalizer.ts` | 统一消息格式转换、工具 schema 适配、beta flags、缓存 TTL |
| **TokenWarning** | `src/renderer/components/TokenWarning.tsx` | 动态指示器：绿(<60%)→黄(60-85%)→黄脉冲(压缩中)→红(overflow/fallback) |
| **ContextVisualization** | `src/renderer/components/ContextVisualization.tsx` | token 分布柱状图 + 压缩时间线 + 活跃 agent + deferred tools |
| **/doctor 诊断** | `src/main/diagnostics/doctorRunner.ts` + `src/shared/commands/definitions/doctorCommands.ts` | 9 类 / 24 项健康检查，CLI 和 GUI 共用 `DoctorReport`，结构化 pass/warn/fail/skip 报告 |

---

## v0.16.55 新增模块

### Agent Team — 并行多代理自主拆分（2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **SpawnGuard** | `src/main/agent/spawnGuard.ts` | RAII 风格并发守卫（max 6 agents, max depth 1），19 个禁用工具 + 只读工具限制 |
| **并行执行** | `src/main/tools/multiagent/spawnAgent.ts` | `executeParallelAgents` 容量检查 + 依赖解析（role→id 映射）+ 结果聚合 |
| **结果聚合** | `src/main/agent/resultAggregator.ts` | 3 种正则提取变更文件、计算 speedup ratio、汇总成本 |
| **活跃上下文** | `src/main/agent/activeAgentContext.ts` | `<active_subagents>` XML 注入 + `drainCompletionNotifications()` 异步通知 |
| **Git Worktree** | `src/main/agent/agentWorktree.ts` | `/tmp/code-agent-worktrees/{agentId}` 隔离，coder 独立分支，无变更自动清理 |
| **wait_agent** | `src/main/tools/multiagent/waitAgent.ts` | 等待指定子代理完成（支持超时） |
| **close_agent** | `src/main/tools/multiagent/closeAgent.ts` | 取消运行中的子代理（AbortController） |
| **send_input** | `src/main/tools/multiagent/sendInput.ts` | 向运行中子代理发送消息（消息队列，executor 每轮消费） |
| **SwarmMonitor UI** | `src/renderer/.../swarm/SwarmMonitor.tsx` | 聚合结果展示（成本卡片、文件变更列表、加速比） |

**核心架构**：

```
Parent Agent
  ├── spawn_agent { parallel: true, agents: [...] }
  │     └── SpawnGuard.canSpawn() → capacity check
  │     └── executeParallelAgents()
  │           ├── Agent A (coder, worktree isolated)
  │           ├── Agent B (reviewer, readonly tools)
  │           └── Agent C (explore, readonly tools)
  │
  ├── contextAssembly 每轮注入:
  │     ├── buildActiveAgentContext() → <active_subagents> XML
  │     └── drainCompletionNotifications() → <subagent_notification> XML
  │
  ├── wait_agent { agent_ids: [...] }
  ├── send_input { agent_id: "...", message: "..." }
  └── close_agent { agent_id: "..." }
```

**3 层任务识别**（自然语言触发，非硬提示词）：
1. 工具描述（静态）— spawn_agent description 中说明并行能力
2. 任务特征检测（动态）— complexKeywords + dimensionKeywords 匹配（中英双语）
3. 上下文自适应抑制（自适应）— 简单任务不建议拆分

---

## v0.16.53 新增模块

### 富文档结构化编辑（DocEdit, 2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Excel 原子编辑** | `src/main/tools/excel/excelEdit.ts` | 14 种操作（set_cell/range/formula, insert/delete rows/columns, style, sheet 管理） |
| **Word 原子编辑** | `src/main/tools/modules/document/docEdit.ts` | 历史 7 种 Word 操作经 DocEdit native 入口承接，旧 `docxEdit.ts` 不再作为当前事实源 |
| **SnapshotManager** | `src/main/tools/document/snapshotManager.ts` | 统一文档快照层（创建/恢复/清理，最多 20 个/文件） |
| **DocEdit 统一入口** | `src/main/tools/modules/document/docEdit.ts` | 自动识别格式（.xlsx/.pptx/.docx）路由到对应引擎 |
| **PPT 编辑加固** | `src/main/tools/modules/network/pptEdit.ts` | +2 新操作（reorder_slides, update_notes），接入 SnapshotManager；生成/版式能力在 `src/main/tools/media/ppt/` |

**设计原则**：原子操作替代全量重写，~80% token 节省。编辑前自动快照到 `.doc-snapshots/`，失败自动回滚。对标悟空 RealDoc。

### Generative UI（2026-03-17）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChartBlock** | `src/renderer/.../MessageBubble/ChartBlock.tsx` | Recharts 6 种图表渲染（bar/line/area/pie/radar/scatter），暗色主题 |
| **GenerativeUIBlock** | `src/renderer/.../MessageBubble/GenerativeUIBlock.tsx` | 沙箱 iframe HTML 小程序渲染（sandbox="allow-scripts"） |
| **Generative UI Prompt** | `src/main/prompts/generativeUI.ts` | System Prompt 注入，教 AI 何时使用 chart vs generative_ui |
| **Artifact 类型** | `src/shared/types/message.ts` | 版本化可视化产物追踪（chart/generative_ui） |

**渲染路由**：MessageContent 的 markdown code block handler 检测 `chart` / `generative_ui` 语言标签，路由到对应 React 组件（与已有 `mermaid` 路由同一模式）。

### Combo Skills（组合技能）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ComboSkillCard** | `src/renderer/.../ChatInput/ComboSkillCard.tsx` | 输入框中的组合技能卡片 UI |
| **Skill IPC** | `src/main/ipc/skill.ipc.ts` | Combo Skill 调度 |

### 文件资源管理器

| 模块 | 位置 | 描述 |
|------|------|------|
| **FileExplorerPanel** | `src/renderer/.../explorer/FileExplorerPanel.tsx` | 左侧文件树面板 |
| **Explorer Store** | `src/renderer/stores/explorerStore.ts` | 文件浏览器状态管理 |

### 对话搜索

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChatSearchBar** | `src/renderer/.../chat/ChatSearchBar.tsx` | 对话内容搜索栏 |

---

## v0.16.52 新增模块

### 轻量记忆系统（Light Memory, 2026-03-15）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Index Loader** | `src/main/lightMemory/indexLoader.ts` | 加载 `~/.code-agent/memory/INDEX.md` 到 system prompt |
| **MemoryWrite 工具** | `src/main/lightMemory/memoryWriteTool.ts` | 写入/删除记忆文件 + 自动维护索引 |
| **MemoryRead 工具** | `src/main/lightMemory/memoryReadTool.ts` | 按需读取记忆详情 |
| **Session Metadata** | `src/main/lightMemory/sessionMetadata.ts` | 追踪使用频率/模型分布（借鉴 ChatGPT） |
| **Recent Conversations** | `src/main/lightMemory/recentConversations.ts` | ~15 条近期对话摘要（借鉴 ChatGPT） |
| **前端面板** | `src/renderer/.../settings/tabs/MemoryTab.tsx` | Light Memory 文件浏览器（替代旧 10+ 组件） |
| **IPC 服务** | `src/main/lightMemory/lightMemoryIpc.ts` | 列出/读取/删除记忆文件 + 综合统计 |
| **会话判定（WS4-A, 2026-05-27）** | `src/main/lightMemory/conversationJudge.ts` | 会话收尾（`runFinalizer`）用 quick model 判 `worth/isMeeting/title/worthKnowledge`，过滤无价值对话（打招呼/确认）；async fire-and-forget 不阻塞；失败回退 `heuristicJudgment`。常量 `SESSION_JUDGE` |
| **记忆整理（WS4-B, 2026-05-27）** | `src/main/lightMemory/consolidation.ts` | 周期压缩：gate 判定是否触发（INDEX>200 行 / 重复 name·description / 文件数≥40），quick model 生成合并计划，信息无损 guard 拒绝孤立删除 + 净删上限闸；默认 dry-run。常量 `MEMORY_CONSOLIDATION` |
| **整理 cron（WS4-B, 2026-05-27）** | `cronService.ts` + `initBackgroundServices.ts` | 新 action `memory-consolidation`，内置 job 周一 04:00 本地时间跑，按 `JOB_TAG` 幂等注册；走 CronService（面板可见 + 执行历史），不起完整 agent 会话 |

**6 层上下文注入架构**（对标 ChatGPT 逆向工程发现的 6 层结构）:
```
[0] System Instructions    — identity.ts（行为规则 + memory_system prompt）
[1] Session Metadata       — 使用频率/活跃天数/模型分布
[2] Memory Index           — INDEX.md 常驻注入（File-as-Memory 核心）
[3] Recent Conversations   — ~15 条近期对话摘要（只摘用户意图）
[4] (removed)              — 旧 RAG Context 已删除（v0.16.56）
[5] Current Session        — 滑动窗口
```

**设计原则**: 模型本身就是最好的记忆引擎。~700 行代码（含前端+IPC）+ prompt 替代旧 13K+ 行 vector/embedding 系统。

### 桌面活动视觉分析（2026-03-15）

| 模块 | 位置 | 描述 |
|------|------|------|
| **视觉分析器** | `src/main/services/desktopVisionAnalyzer.ts` | 后台轮询截图，调用智谱 GLM-4V-Plus 生成语义描述 |
| **Rust 采集增强** | `src-tauri/src/native_desktop.rs` | 截图 PNG→JPG（~80% 空间节省）、`analyze_text` 字段、SQLite 自动迁移 |
| **Tauri 命令** | `desktop_update_analyze_text` | Node 侧写回视觉分析结果到 Rust 管理的 SQLite |

### 架构清理与评测修复（2026-03-09 ~ 03-12）

| 改动 | 描述 |
|------|------|
| **AgentApplicationService** | IPC facade 解耦（`agentAppService.ts`），所有 IPC handler 不再直接依赖具体实现 |
| **agentLoop 拆分** | 4350 行单文件拆为 5 个 runtime 模块（`conversationRuntime.ts` 等），agentLoop 变为 thin wrapper |
| **循环依赖清零** | 114→15→9→0（madge 验证），sessionStore 拆分、IPC facade、bootstrap 4 模块拆分 |
| **死代码清理** | -13,654 行 agent 子系统 + -2,497 行 memory 模块，净减 ~16K 行 |
| **Disposable 扩展** | 11 个资源持有服务实现 Disposable 接口，gracefulShutdown 统一释放 |
| **Session 边界加固** | per-session IPC facade + Bridge session-aware + getter 副作用移除 |
| **评测生产隔离** | evaluation 模块 dynamic import + `EVAL_DISABLED` define，生产包不含评测代码 |
| **esbuild 统一** | 6 个独立 esbuild 命令合并为单一 `esbuild.config.ts` |

---

## v0.16+ 核心模块总览

以下为跨版本积累的核心模块（按能力域分组）。

### Agent 与多 Agent 协作

| 模块 | 位置 | 描述 |
|------|------|------|
| **混合 Agent 架构** | `src/main/agent/hybrid/` | 3 层：核心角色 + 动态扩展 + Swarm |
| **内置 Agent** | `src/shared/types/builtInAgents.ts` | 6+11 个预定义 Agent 角色 |
| **Agent 团队** | `src/main/agent/teammate/` | 持久化团队、生命周期管理（create/resume/snapshot/shutdown） |
| **SpawnGuard** | `src/main/agent/spawnGuard.ts` | 并发守卫（max 6 agents）+ 通知队列 + 消息队列 + 只读工具限制 |
| **Result Aggregator** | `src/main/agent/resultAggregator.ts` | 子代理结果聚合（文件提取、加速比计算、成本汇总） |
| **Active Agent Context** | `src/main/agent/activeAgentContext.ts` | 运行中子代理 XML 注入 + 异步完成通知 |
| **Agent Worktree** | `src/main/agent/agentWorktree.ts` | Git worktree 隔离（coder 角色独立分支，无变更自动清理） |
| **优雅关闭** | `src/main/agent/shutdownProtocol.ts` | 4 阶段关闭（Signal→Grace→Flush→Force） |
| **跨 Agent 审批** | `src/main/agent/planApproval.ts` | 高风险操作 plan → Coordinator 审批（可选） |
| **Adaptive Thinking** | `src/main/agent/agentLoop.ts` | InterleavedThinkingManager + effort 级别控制 |
| **Delegate 模式** | `src/main/agent/agentOrchestrator.ts` | Orchestrator 只分配不执行 |
| **h2A 实时转向** | `src/main/agent/agentLoop.ts` | `steer()` 注入用户消息，保留中间状态 |

### 工具与调度

| 模块 | 位置 | 描述 |
|------|------|------|
| **DAG 调度器** | `src/main/scheduler/` | 基于 DAG 的并行任务调度 |
| **工具 DAG** | `src/main/agent/toolExecution/dagScheduler.ts` | 文件依赖 DAG + Kahn 拓扑排序 |
| **ToolSearch** | `src/main/tools/gen4/toolSearch.ts` | 延迟加载工具发现机制 |
| **Checkpoint** | `src/main/services/FileCheckpointService.ts` | 文件版本快照与回滚 |
| **Skills 系统** | `src/main/skills/` | 用户可定义技能 + 数据清洗 Skill |

### 上下文与记忆

| 模块 | 位置 | 描述 |
|------|------|------|
| **投影式上下文管理** | `src/main/context/` | 6 层压缩管线（tool-result budget → snip → microcompact → contextCollapse → autocompact → overflow recovery），投影架构：transcript 不可变，CompressionState 追踪，ProjectionEngine 查询时生成 API 视图 |
| **文档上下文** | `src/main/context/documentContext/` | 统一文档理解层，5 种解析器 |
| **DataFingerprint** | `src/main/tools/dataFingerprint.ts` | 源数据锚定（xlsx schema + CSV/JSON schema） |
| **FileReadTracker** | `src/main/tools/fileReadTracker.ts` | 文件读取记录，支持编辑验证和恢复上下文 |

### 模型与路由

| 模块 | 位置 | 描述 |
|------|------|------|
| **自适应路由** | `src/main/model/adaptiveRouter.ts` | 简单任务 → glm-4-flash（免费），失败原因感知 fallback（overflow→更大窗口，rate_limit→换 provider） |
| **推理缓存** | `src/main/model/inferenceCache.ts` | LRU 缓存（50 条，5min TTL） |
| **错误恢复引擎** | `src/main/errors/recoveryEngine.ts` | 6 种错误模式自动恢复 |
| **Moonshot Provider** | `src/main/model/providers/moonshot.ts` | Kimi K2.5 / Kimi K2.6 SSE 流式支持 |

### 工程能力

| 模块 | 位置 | 描述 |
|------|------|------|
| **引用溯源** | `src/main/services/citation/` | 自动提取引用（文件行号/URL/单元格） |
| **确认门控** | `src/main/agent/confirmationGate.ts` | 写操作前 diff 预览 + 确认 |
| **变更追踪** | `src/main/services/diff/diffTracker.ts` | 结构化 unified diff |
| **模型热切换** | `src/main/session/modelSessionState.ts` | 对话中途切换模型 |
| **安全校验** | `src/main/security/inputSanitizer.ts` | prompt injection 检测 |

### 评测 / 回放基础设施

> v0.16.79 移除了 per-session grader + 失败漏斗 + evalCenter UI 死代码（评测双管道、SwissCheese 评估器、deliveryReview / previewFeedback 一并删除）。`src/main/evaluation/` 现仅保留下面的 trajectory / replay / telemetry / experiment 活路径，telemetry IPC / agentOrchestrator / bug-report replay 仍依赖；外部评测用 `packages/eval-harness/`。

| 模块 | 位置 | 描述 |
|------|------|------|
| **Session Replay** | `src/main/evaluation/replayService.ts` + `transcriptReplayBuilder.ts` | 结构化会话回放 |
| **Trajectory 采集** | `src/main/evaluation/trajectory/` | 轨迹记录 |
| **Telemetry Query** | `src/main/evaluation/telemetryQueryService.ts` | 遥测查询（意图分类、缓存、replay 完整度证据）|
| **Experiment Adapter** | `src/main/evaluation/experimentAdapter.ts` | `experiments` / `experiment_cases` 实验跟踪 |
| **Session Event** | `src/main/evaluation/sessionEventService.ts` | `session_events` 落库 |
| **Eval Harness** | `packages/eval-harness/` | 外部评测框架（独立于 app 运行时）|

### 基础设施

| 模块 | 位置 | 描述 |
|------|------|------|
| **统一配置** | `src/main/config/configPaths.ts` | `.code-agent/` 配置目录结构 |
| **基础设施服务** | `src/main/services/infra/` | 磁盘监控、文件日志（NDJSON + 按日轮转）、优雅关闭 |
| **CLI 运行时** | `src/cli/` | 5 模式（chat/run/serve/exec-tool/mcp-server）、CLIAgent 适配层 |
| **多渠道接入** | `src/main/channels/` | 飞书 Webhook 等渠道支持 |

---

## Local Bridge 服务

为 Web 端提供本地能力的桥接服务，通过 HTTP + WebSocket 在 localhost:9527 运行。

### 工具清单（三级权限）

| 级别 | 权限 | 工具 |
|------|------|------|
| L1 只读 | 自动执行 | file_read, file_glob, file_grep, directory_list, clipboard_read, system_info |
| L2 写入 | 需确认 | file_write, file_edit, file_download, open_file |
| L3 执行 | 白名单+确认 | shell_exec, process_manage |

### Web 端工具调用数据流

```
agentLoop.executeTool(Read)
  → webServer 识别为本地工具 (isLocalTool)
  → SSE 推送 tool_call_local 事件
  → 前端 httpTransport 拦截
  → LocalBridgeClient.invokeTool("file_read", params)
  → Bridge localhost:9527 执行
  → POST /api/tool-result 回传
  → agentLoop 继续对话
```

---

## 版本演进摘要

<details>
<summary>v0.16.16 ~ v0.16.42 历史版本（点击展开）</summary>

| 版本 | 主题 | 关键变更 |
|------|------|----------|
| **v0.16.16** | 基础设施 | 统一配置目录 `.code-agent/`、Moonshot Provider、记忆衰减、Few-shot 示例、原子写入 |
| **v0.16.18** | 评测体系 | 混合 Agent 架构、统一 Identity（token -81%）、评测双管道、SwissCheese 评估器、Logger 文件落盘 |
| **v0.16.19** | 工程能力 E1-E6 | 引用溯源、确认门控、变更追踪、模型热切换、文档上下文、安全校验、PPT 9 模块声明式重构 |
| **v0.16.20** | 对标 Claude Code | 增强型 Compaction、Agent Teams P2P 通信、Delegate 模式、Adaptive Thinking、DeepSeek Thinking UI |
| **v0.16.21** | 健壮性 | h2A 实时转向、TaskListManager、Compaction 恢复、溢出自动重试、动态 Bash 描述 |
| **v0.16.22** | 成本优化 | 推理缓存、自适应路由（免费模型）、错误恢复引擎、工具 DAG 调度、Prompt 精简 -20% |
| **v0.16.37** | 多 Agent 增强 | 持久化团队、优雅关闭 4 阶段、子 Agent 任务自管理、跨 Agent 审批、DataFingerprint 源数据锚定 |
| **v0.16.42** | 分层压缩 | L1 Observation Masking → L2 Truncate → L3 AI Summary 三层递进压缩 |
| **v0.16.53** | 富文档编辑 | DocEdit 统一入口、Excel 14 操作、Word 7 操作、PPT 编辑加固、SnapshotManager |
| **v0.16.55** | Agent Team | SpawnGuard 并发守卫、并行多代理执行、Git Worktree 隔离、异步完成通知、结果聚合 |
| **v0.16.57** | 架构对齐 | 投影式上下文管理（6 层压缩）、Prompt 矩阵（4 Profile × 5 Overlay）、GuardFabric 多源权限、事件三通道、Worker Epoch、多模型差异化路由、Operator Surface |
| **v0.16.66** | Agent Runtime Hardening | run lifecycle 终态、run-level abort、TaskManager-owned chat、MCP direct execute、Skill trust gate、multiagent reliability、structured replay gate |
| **v0.16.71** | Hardening + 评测扩面 + Design Brief | Tauri updater 安全 (M6.a/b)、EventBus & dispatch 归位、调试快照体系 (ADR-014)、本地 Ollama 评测 (ADR-013)、SWE-bench docker harness (ADR-015)、小米 MiMo provider + 默认模型切换、Design Brief 生产化 (Phase A→C.3)、Workspace Preview Panel、Channel inbox/outbox |
| **v0.16.72-73** | Native protocol + acceptance + isolation + quality gates | Level 1 native tool migration wave1-4、Runtime/Web/Context hardening、Artifact repair toolkit、Game/Deck/Dashboard verifier、Browser/Computer multi-agent isolation、typed IPC、provider wrappers/symmetry、async/god-file/cleanup |
| **v0.16.74** | Prompt / Hook / Rewind | Prompt Manager + 实时 override、Hook Settings tab、Hook Activity turn timeline、CLI hooks 默认启用、Chat workspace defaults、Prompt Rewind + session_rewinds 审计 |
| **v0.16.75** | Agent Neo 管理面 + 外部 Agent Engine + In-App 验证 | Agent Neo 品牌层、本地 API Key onboarding、Codex/Claude 外部 engine read-only 接入、Capability Center 本地 registry、In-App HTML Validation、Background Task Ledger、管理员用户/邀请码、可选 Tauri 更新、release security scan |
| **v0.16.76-79** | 插件化 + 能力路由 + 死代码瘦身 + 依赖大版本 | PluginAPI v2 + 7 个 builtin plugins、Plugin 化三层边界 (ADR-017)、desktop facade 收口、Marvis 能力路由 + chat capability triggers、删 evaluation 子系统 (-20K 行/5 表)、quick model 并发限流 + glm-4-flash、工具失败输出对模型可见、依赖 ~25 个大版本升级 (TS6/Vite8/React19/Tailwind4)、release staple/公证管线 |
| **v0.16.80** | Goal Mode + AI SDK 双引擎 + Appshots + OS 沙箱 | `/goal` 三层闸（确定性 verify exec + Reviewer 子代理 + 代码层兜底，判定权落代码层）、Provider 迁 Vercel AI SDK 双引擎（可一键回退/消灭流式-非流式解析不对称 bug）、Appshots 左右 Cmd 双击截窗注入多模态、bypassPermissions 接 sandbox-exec/bwrap 命令包装 + fail-fast |
| **v0.16.88** | AI SDK 全量收口 + Light Memory 质量闭环 + MCP 只读边界 + Alma 渲染 | 全 provider 迁 AI SDK（gemini/openrouter 官方包、zhipu/moonshot/xiaomi openai-compatible，`AISDK_UNSUPPORTED_PROVIDERS` 清空）、Light Memory 会话判定 (WS4-A) + 整理 cron (WS4-B)、MCP server 控屏永不暴露收敛为 5 个只读工具 (WS5)、聊天 `contentParts` 交错渲染 + 流式动效 + neo:// 深链卡片 + computer-use PiP |

</details>

---

## 如何使用本文档

1. **新人入门**: 先阅读 [系统概览](./architecture/overview.md)
2. **开发功能**: 查阅对应模块的详细文档
3. **理解决策**: 查看 [ADR](./decisions/) 了解架构决策背景
4. **贡献代码**: 遵循各文档中的设计原则

## 更多文档

- [Release Notes](./releases/) — 版本发布记录
- [工具参考手册](./guides/tools-reference.md) — 全部工具的完整文档
- [模型配置矩阵](./guides/model-config.md) — 模型路由与配置
- [评测系统指南](./guides/evaluation-system.md) — 评测工程详细文档
- [ADR-005: Eval Engineering](./decisions/005-eval-engineering.md) — 评测关键工程决策

### 功能设计 spec（docs/designs/）

- [/goal 模式设计](./designs/goal-mode.md) — Goal Mode 三层闸（as-built 校准）
- [Appshots 设计](./designs/appshots.md) — 窗口快照 → 多模态上下文（macOS）
- [附件管线 v2 设计](./designs/attachments.md) — 多类型附件 → 端侧摘要 → 模型上下文（🚧 wip，待 review）
