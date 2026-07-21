# Agent Neo / Code Agent - 架构设计文档

> 版本: 9.29 (9.28 + 2026-07-12~18 Durable Run 生产切换、Web/External 终态单一事实源、renderer 权限与工具事件投影、Skill IPC 类型合同、事件假 seam 清理、桌面启动分段与更新后 compile-cache 预热；详见 runtime safety as-built spec 与 ADR-037)
> 版本: 9.28 (9.27 + 2026-06-26 Neo Tools evidence/control 收口：统一 EvidenceRef、goal verification card、Browser/Computer durable proof、Agent Pointer 可见化、background/subagent recovery plan、agent tree/worktree read-only review；当前合同已折入本文对应能力域与 ADR-029)
> 版本: 9.27 (9.26 + 2026-06-22 设计 tab 4 媒介重规划 + 厚版演示稿全链路：引擎从 agent 工具抽 service、SlideData[] 单一真源、大纲编辑器/逐页预览/就地改字、4 增强〔品牌色注入 OKLCH→sRGB / AI 大纲 / LibreOffice 像素预览 / AI 配图模型可选〕，PR #260；详见 design-mode.md §15)
> 版本: 9.26 (9.25 + 2026-06-16~17 迭代治理与账本收口：permission/tool execution append-only ledger、Swarm ledger 真理源 + reconcile/backfill、console/a11y/stale-dist 静态门、设计系统契约 + ratchet gate、预算告警、工具失败 action、Bash 输出头尾预览、auto-compaction stuck guard)
> 版本: 9.25 (9.24 + 2026-06-13~15 会话页、设置页与运行证据门收口：能力证据硬门 + judge 校准、TurnQuality / ReplayAudit、任务模型策略、模型决策可解释、语音输入、快捷键、目标合同 composer、媒体资产、设置页分组导航/搜索/权限、隐私/通道通知边界、Skills/MCP/Plugins 可见管理、项目/会话组织)
> 版本: 9.24 (9.23 + 2026-06-12 release-prep hardening：renderer production verifier metadata/bundle timeout + stage diagnostics、checkpoint rebuild foreground short wait + fail-closed、vision empty-response failure reason、skill draft 低价值工具序列名拒绝、session task tree parent recovery)
> 版本: 9.23 (9.22 + 2026-06-11~12 Agent runtime / MiMoCode / Ops 批次：MiMoCode 快赢与两轮 Codex audit、transcript FTS + History 工具、命令协议层、provider prompt variants、memory BM25、dream consolidation、Max Mode best-of-N、嵌套 subagent 默认 3 层/硬上限 5 层、CUA 锁与轨迹治理、MCP self-service + HTTP Streamable、Admin role RPC、renderer active bundle 低于 shell 版本回退 builtin、诊断导出失败打开 runtime logs)
> 版本: 9.22 (9.21 + 2026-06-10~11 Windows (win32-x64) 移植与发版链折入：P0 安全/路径地基（权限路径旁路修复 + commandSafety 平台规则包）+ NSIS unsigned 打包链 + 天翼云真机打通（5 个实现期 bug）+ release.yml 独立 build-windows job（三平台 latest.json，windows 失败降级 mac-only，预发布 tag 空跑全绿）+ 全入口设备感知下载/更新（修资产选择两处真 bug）+ ConnectorRegistry 平台过滤 + PII 安装链 Node 化)
> 版本: 9.21 (9.20 + 2026-06-09 Computer Use 底座迁移 argus → trycua/cua-driver（ADR-021：stdio MCP 接入 + 桌面走 cua/浏览器走 Playwright 分流 + 重签名内嵌 Agent Neo Computer Use.app + cua 工具人话文案/真实 app 图标差异化渲染 + Accessibility 必需/录屏可选）)
> 版本: 9.20 (9.19 + 2026-06-08 经验沉淀重做（ADR-020：废弃 telemetry n-gram，统一 LLM 反思路 + 命名禁用清单）、Telemetry 可诊断性 P1+P2+P3（版本指纹 + 本地全量诊断旁表/诊断包/脱敏/失败 session 上报 + Langfuse 默认开 opt-out）、卸载/权限三层修复（safety 措辞 + rm 分级松绑 + 挂起权限死锁）、06-07 下午 provider/session/vision 稳定性收尾)
> 日期: 2026-07-18
> 作者: Lin Chen

本文档是 Agent Neo（代码仓库仍名为 Code Agent）的**架构索引入口**。详细设计已拆分为模块化文档，本文提供导航、快速参考和版本演进概要。

---

## 文档导航

### 核心架构

| 文档 | 描述 |
|------|------|
| [仓库导览](./architecture/repo-map.md) | 第一次浏览仓库时先看：根目录、运行面、能力体系、评测目录怎么分 |
| [系统概览](./architecture/overview.md) | 整体架构图、技术栈、分层设计 |
| [Agent 核心](./architecture/agent-core.md) | AgentLoop、运行时状态机、run-level abort、TaskManager-owned chat send、ContextAssembly |
| [Durable Run Kernel](./architecture/durable-run-kernel.md) | 跨 Native/Team/Workflow/External 的 run identity、owner epoch、原子 checkpoint/terminal 与生产读取合同 |
| [Durable Runtime Integration](./architecture/durable-runtime-integration.md) | 启动恢复 dispatcher、各 engine handler、read preference、fail-closed readiness 与回滚边界 |
| [External Engine Durable Lifecycle](./architecture/external-engine-durable-lifecycle.md) | Codex/Claude/MiMo/Kimi 外部进程 checkpoint、恢复能力矩阵、终态证据和 trace 规则 |
| [工具系统](./architecture/tool-system.md) | ToolRegistry、ToolExecutor、Core/Deferred、MCP dynamic tools、权限合同 |
| [前端架构](./architecture/frontend.md) | React 组件、Zustand 状态、useAgent Hook |
| [IPC 通道](./architecture/ipc-channels.md) | domain handler、共享 invoke 类型合同、zod 迁移边界与 renderer 调用规范 |
| [Desktop Shell](./architecture/desktop-shell.md) | Tauri 壳、bundled Node/webServer、启动就绪、更新后预热、资源预检与诊断合同 |
| [数据存储](./architecture/data-storage.md) | SQLite、Supabase、session runtime state、telemetry/replay、SecureStorage |
| [云端/同步历史架构](./architecture/cloud-architecture.md) | 历史 cloud task / orchestrator 设计归档；当前保留配置、更新、feature flag、cloud proxy 等服务 |
| [多 Agent 编排](./architecture/multiagent-system.md) | Agent Team 并行执行、parallel inbox、dependsOn gate、run-level cancel、SpawnGuard |
| [Agent Engine 执行引擎](./architecture/agent-engine.md) | 执行内核(AgentEngineKind)≠模型 provider：Native + Codex/Claude/**MiMo/Kimi** 四外部 CLI 引擎接入(registry 探测 + 适配器分发 + catalog)、Runtime×Model 兼容矩阵 + billingMode(订阅/按量)、设置页「执行引擎」section、StatusBar「Engine·模型·Effort」切换器 |
| [Dynamic Workflow](./architecture/dynamic-workflow.md) | 命令式脚本编排运行时：模型写 JS 脚本 → worker 沙箱后台执行、5 原语、forced 结构化、provider-aware 并发闸、token budget、跑前审批、resumable |
| [Runtime Consolidation Snapshot](./architecture/runtime-consolidation-2026-05-31.md) | 2026-05-29~06-01 运行时收口 as-built：workflow、provider 控制、app-host 验收、observability、dead path 归属、product closure |
| [Agent Architecture Debt Iteration](./architecture/agent-architecture-debt-iteration-plan-2026-05-31.md) | runtime ports、model/app-host 拆分、prompt/session/eval gates 的分阶段闭环 |
| [Chat-Native Workbench](./architecture/workbench.md) | 聊天主链路能力工作台（ConversationEnvelope + InlineWorkbenchBar + Turn Timeline + Prompt Rewind），与 TaskPanel(sidecar) 分工 |
| [Artifact Verification](./architecture/artifact-verification.md) | Game/Deck/Dashboard verifier、repair guard、ArtifactIssue、EvalReplayQualityReport、Admin Review Queue；旧 AcceptanceRunner / Delivery Review / Preview Feedback 已下线 |
| [Activity Providers](./architecture/activity-providers.md) | OpenChronicle / Tauri Native Desktop / audio / screenshot-analysis 统一上下文 provider 边界 |
| [Native App 集成](./architecture/native-app-integration.md) | Skill / Tool / Service / Connector / MCP 边界与调用链路；为什么 macOS 原生应用走 connector 不走 MCP |
| [CLI 架构](./architecture/cli.md) | 5 种运行模式、CLIAgent 适配层、输出格式化、命令系统 |
| [Windows 支持](./architecture/windows-support.md) | win32-x64 移植：安全与路径地基、PowerShell 命令安全规则包、NSIS unsigned + minisign 发版链、真机调试记录、朋友验收清单 |
| [Intel x64 支持](./architecture/intel-x64-support.md) | darwin 双架构（arm64 + x64）矩阵构建、资源覆盖机制、updater manifest 合并先例 |
| [Surface Execution](./architecture/surface-execution.md) | Browser/Computer 统一执行运行时（ADR-046）：owner 三元组 Session/Grant/Observation 合同、可中止操作队列、Relay 协议 v2 + tab lease、Stateful CUA 适配、会话执行体验单一投影（Timeline/Evidence 三态/PiP）、全链脱敏与验收证据体系 |
| [Design Mode 设计工作区](./architecture/design-mode.md) | 全屏设计工作台 as-built：**Tab 按交付媒介分 4 类(网页/图/演示稿/视频，`DesignOutputType` UI 聚合零破坏)**；网页(agent 编排) + 图〔设计稿/信息图〕(renderer 直连出图) + 视频(t2v/i2v) + **厚版演示稿(§15：引擎从 agent 工具抽 `services/design/slidesGenerator`，SlideData[] 单一真源，大纲编辑器/逐页预览/就地改字；4 增强=品牌色注入 OKLCH→sRGB / AI 大纲 / LibreOffice 像素预览 / AI 配图模型页面可选，付费 opt-in 成本前置)**；konva 自研无限画布、T1-T6 变体 spine/成本/一致性；P1 视觉模型注册表(D1 单源)多模型切换 + 标注重绘 + SSRF 守卫；**UC 参考图垫图(生成前贴图喂 wanx description_edit) + 统一历史(图像/视频/原型收口左侧一处、role-aware 分组)** |

### 近期规格

| Spec | 覆盖 |
|------|------|
| [Neo Runtime Safety as-built](./plans/2026-07-11-neo-runtime-safety-as-built-spec.md) | 7 月 4~18 日 as-built：Durable Run 终态事实源、Agent Team/External 恢复、权限队列、renderer 工具卡身份、Skill IPC 类型合同与桌面启动就绪边界 |
| Neo Tools Evidence Control and Agent Pointer | 6 月 26 日 as-built：统一 `EvidenceRef`、goal verification card、CI log ingest、Browser/Computer durable proof timeline、Neo virtual pointer、session evidence control summary、background/subagent recovery plan、Browser launch helper split |
| Iteration Governance / Ledger / Budget / Design System | 6 月 16~17 日 as-built：权限决策和工具执行 append-only ledger、Swarm ledger 真理源、reconcile scan 和 opt-in backfill、console/a11y/stale-dist 静态门、设计系统契约与 ratchet gate、预算告警、失败工具 action、Bash 输出头尾预览和 auto-compaction 卡死护栏 |
| Session Surface / Settings IA / Eval Gates | 6 月 13~15 日 as-built：能力证据硬门、judge 校准、TurnQuality / ReplayAudit、任务模型策略、模型决策可解释、语音输入、快捷键、目标合同 composer、媒体资产、设置页分组导航/搜索/权限、隐私/通道通知边界、Skills/MCP/Plugins 可见管理、项目/会话组织 |
| Agent Runtime / MiMoCode / Ops Batch | MiMoCode 快赢与 hardening、transcript FTS + History、命令协议层、superpowers 方法论 skill、provider prompt variants、memory BM25、dream consolidation、Max Mode、嵌套 subagent、CUA 治理、MCP self-service + HTTP Streamable、Admin role RPC、renderer stale active bundle fallback、renderer production verifier timeout、checkpoint 前台短等、skill draft 名称质量闸、vision failure reason、诊断导出失败日志兜底 |
| Windows 移植与发版链折入 | 两天 as-built：P0 安全/路径地基（权限旁路修复 + commandSafety 平台规则包 51 用例）、NSIS 打包链 + CI 实跑绿、天翼云真机打通（5 个实现期 bug）、release.yml 矩阵折入（windows 失败降级 mac-only + 预发布 tag 空跑全绿）、全入口设备感知（修资产选择两处真 bug）、ConnectorRegistry 平台过滤、PII 安装链 Node 化 |
| 经验沉淀重做 + Telemetry 可诊断性 + 稳定性收尾 | 经验沉淀重做（ADR-020：物理移除 telemetry n-gram 频次蒸馏，统一收口 conversationReview LLM 反思路，入口闸+反思门+命名禁用清单+结构化 SKILL.md）、卸载/权限三层修复（safety 措辞改"直接调工具"/rm 目标明确删除从硬毙降为一次确认/挂起权限死锁随新消息 resolve）、Telemetry 可诊断性 P1+P3（agentVersion/promptVersion/toolSchemaVersion 版本指纹进 trace+session、Langfuse 默认开+opt-out）、06-07 下午 provider/session/vision 稳定性收尾 |
| 对话式角色 + 会话自动化 + 模型设置收口 | `/schedule` 空参模板创建、`/loop` 后台化 + meta turns + task ledger 通知、定时 agent 完成通知、原生通知 renderer 投递、对话式新建/修改持久化角色（roleDraftQueue + propose_role + strict skill toolset）、模型设置 provider 保存与默认模型拆分 |
| 多 Agent 协作层 + 项目空间 + 角色产品化批次 | swarm goal（P4 allowSwarm + advance 合流）、swarm 护栏（结构化失败码/深度截断/孤儿回收/Inbox 桥接）、swarm 协作可见性（讨论流）、角色主动性（cadence+event 双触发，出厂 silent）、项目空间三表 + 隐式归桶 + 跨 session 产物聚合、定点反馈两层分离、能力产品化（角色/技能 icon+分类）、只读任务状态 MCP（P3-A 三工具） |
| 自动模式路由体系 + 设置页重构批次 | 自动模式失效三断点修复 + ADR-019 三批（modelDecision 单一决策入口/计费四分类/路由可视化）、设置页 Master-Detail/双 Tab 系列、推荐目录云端下发、Onboarding 中转站、僵尸实例三层自愈、生产 trace 回传修复 |
| 极客时间课程差距修复（四阶段 as-built） | 17 条 GAP 修复：skill 限权/policy 接线/prompt caching（假护栏）、MCP 索引化/结果落盘/git 注入（上下文经济）、Stop hook 完成闸/反死循环/交付前 critic/prompt 预算治理（质量闭环）、failure journal/skill 蒸馏/子代理 skills/harness 对照实验（经验沉淀） |
| Runtime Consolidation and Dynamic Workflow | 2026-05-29~06-01 运行时、workflow、provider、app-host、prompt gate、owner scope、dead path 下线 |
| Agent Neo Product Closure | 默认长任务路径、安全自治、managed runtime、artifact issue/replay quality release loop |

### 架构决策记录 (ADR)

| ADR | 标题 | 状态 |
|-----|------|------|
| 001 | Turn-Based 消息流架构 | accepted |
| 002 | ~~8 代工具演进策略~~ | superseded |
| 003 | 云端-本地混合执行架构 | accepted |
| 004 | 统一插件配置目录结构 | proposed |
| 005 | Eval Engineering Key Decisions | accepted |
| 006 | Deferred Tools 合并精简 (Phase 2) | accepted |
| 007 | Protocol 迁移现实性复盘 | accepted |
| 008 | Swarm Actor 重构 | accepted |
| 009 | 双 Coordinator 拆分 | accepted |
| 010 | Swarm Road to 10 | closed |
| 011 | Chat-Native Workbench 架构 | accepted |
| 012 | Live Preview V2-C Next.js 支持延期，V2 收敛为 Vite-only MVP | accepted |
| 013 | 评测中心 + 主聊天支持本地 Ollama 模型 | accepted |
| 014 | 调试快照系统 + CLI debug 命令树 | accepted |
| 015 | SWE-bench docker-based eval harness | accepted |
| 016 | 不提前抽 cross-kind verifier interface | accepted |
| 017 | Plugin 边界三层划分 | accepted |
| 018 | MasterTask sunset | accepted |
| 019 | 自动模式（Auto Mode）的能力边界与取舍 | accepted |
| 020 | 经验沉淀重做（废弃 telemetry n-gram，统一 LLM 反思路） | accepted |
| 021 | Computer Use 底座 argus → cua-driver | accepted |
| 029 | 统一 Evidence / Provenance 契约 | accepted |
| 030 | Fleet 遥测双通道（Sentry 错误通道 + Supabase 分析通道） | proposed |
| 031 | @Neo 运行时安全护栏（approved Neo run 的 fail-closed 工具边界） | accepted |
| 032 | 请求前缀稳定与主动工具结果裁剪（cache 经济学下半场） | accepted |
| 034 | Neo Tag 轻量化重设计（@neo 直接开干 + 内联清单 + topic 目录） | accepted |
| 035 | Neo Tag 跨会话 Topic（@neo 续接不被发起会话困住） | accepted |
| 036 | 评测判分可信度收口 + 红线 case 执行闸 | accepted |
| 037 | Durable Run Kernel（run 身份/所有权/恢复语义） | accepted |
| 038 | RuntimeContext 拆袋（共享可变袋分批收敛为切片状态） | accepted |
| 039 | Artifact repair 无进展逃生门统一语义 | accepted |
| 040 | Artifact Locator 契约（预览定点与编辑目标统一对账） | accepted |
| 041 | 浏览器登录态复用双通道与 `browser_action` 双引擎对标 | accepted |
| 042 | 远程 MCP OAuth 浏览器授权（SDK OAuthClientProvider 接线） | accepted |
| 043 | 组级工具步骤三态折叠预览 | accepted |
| 045 | 上下文压缩单一架构：删除旧三层 `checkAndCompress` 入口 | accepted |
| 046 | Surface Execution V1：Browser/Computer 统一 owner-aware 执行运行时 | accepted |

> **ADR-040 执行状态（2026-07-18）**：Word / PPT / Excel locator、共享 picker、generated-PPT resolver 与隐私安全 telemetry 已随 #377/#385 合入 `main`。Poppler `26.07.0` 双原生架构候选由 run `29412794021` 产出并发布到项目控制的不可变 OSS 前缀，`config/poppler-sidecar.lock.json` 已为 `ready`，Poppler promotion stop-ship 已解除；正式版本仍需走常规签名、公证、DMG 与安装版验收。

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
| Agent Engine | Native Agent Neo / Codex CLI / Claude Code / MiMo-Code / Kimi Code，签名模型目录、session engine metadata、read-only 外部执行、Durable Run 终态与 task ledger 回带 |
| 本地桥接 | packages/bridge (localhost:9527) |
| 代码编辑 | CodeMirror 6 (Preview 代码/Markdown 编辑模式) |

### 目录结构

```
code-agent/
├── src/
│   ├── host/              # 后端主进程：Agent、工具、服务、权限、任务、运行时
│   ├── renderer/          # React 前端
│   ├── shared/            # 前后端共享类型、常量和契约
│   ├── web/               # 本地 HTTP/SSE server
│   ├── cli/               # CLI 入口与适配层
│   ├── design/            # 设计工作区共享逻辑
│   └── artifacts/         # 产物类型与处理
├── src-tauri/             # Tauri Rust 桌面外壳
├── admin-console/         # 独立管理后台
├── packages/              # bridge、eval-harness 等复用包
├── vercel-api/            # 官网、下载与控制面 API
├── supabase/              # 数据库迁移与云函数
├── tests/                 # unit、renderer、integration、e2e、smoke
├── scripts/               # 构建、发布、治理、验收和运维脚本
├── config/                # 可入库的发布制品锁（不存放 secret / 用户配置）
└── docs/                  # 架构、部署、API、计划、审计和发布记录
```

完整根目录说明见 [仓库导览](./architecture/repo-map.md)，`src/host` 的领域归属见 [源码地图](./architecture/source-map.md) 和 [`src/host/README.md`](../src/host/README.md)。测试、脚本与 GitHub Actions 的维护约定分别见 [`tests/README.md`](../tests/README.md)、[`scripts/README.md`](../scripts/README.md) 和 [`.github/README.md`](../.github/README.md)。

### 工具体系（108+ 个 native ToolModule）

按功能分为 9 类，其中 15 个核心工具始终发送给模型，其余通过 ToolSearch 按需加载。2026-05 native migration 后，`src/host/tools/registry.ts` 注册 108 个 ToolModule；2026-06-05 角色创作分支新增 deferred 工具 `propose_role`，合并后进入同一 native module registry。下表按能力域说明，不把每类数量写成长期不变量。

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

> **工具合并**: 31 个独立延迟工具合并为统一工具（Process, MCPUnified, TaskManager 等），使用 action 参数分发。详见 ADR-006。
>
> **文档编辑统一**: DocEdit 统一入口，富文档为原子级增量编辑（Excel 14 操作 / PPT 8 操作 / Word 7 操作），SnapshotManager 提供快照回滚。

### 2026-07-12 ~ 07-18 Durable 执行、客户端事件与启动路径收口

这一轮把运行终态、客户端投影和桌面启动从多处“各自看起来正确”收敛为可追溯合同。长期边界是 durable store 决定运行事实，renderer 只按稳定身份投影，IPC 和事件层只保留真实消费路径，启动优化不能削弱 readiness 与回滚。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Durable Run 生产事实源 | 六表 kernel、owner epoch、attempt、event/checkpoint sequence 与 terminal projection 已接 Native、Agent Team、Dynamic Workflow、External CLI、MCP long task；`durable_preferred` 为生产默认读策略 | `src/host/runtime/durableRunKernel.ts`、`durableRunStores.ts`、`src/host/app/durableRunReadService.ts`、`docs/architecture/durable-run-kernel.md` |
| Web route 生命周期 | `/api/agent` 在 SSE headers 前创建 run；`AgentDurableRouteRunLifecycle` 私有持有 start/terminal/release，重复调用幂等；pre-stream 和 mid-stream 断连统一提交 `run_cancelled` | `src/web/routes/agent.ts`、`agentDurableRouteLifecycle.ts`、对应 unit tests |
| External 终态诚实性 | Codex/Claude 只有解析到最终正文/结果才能完成；exit 0 + 空输出提交 `failed`；cancellation 优先于晚到结果；MiMo/Kimi 无法证明恢复时进入 `requires_review` | `src/host/services/agentEngine/externalEngineDurableLifecycle.ts`、`codexCliAdapter.ts`、`claudeCodeAdapter.ts`、`docs/architecture/external-engine-durable-lifecycle.md` |
| Renderer 权限与工具事件 | permission/task/tool effects 抽为可测事件投影；权限队列按 session/global 分桶，terminal 只清对应 session，Esc 发送 deny；工具结果用 `toolCallId` 精确绑定，同名卡不猜测 | `usePermissionQueueEffects.ts`、`useTaskProgressEffects.ts`、`useToolExecutionEffects.ts`、`appStore.ts`、`useKeyboardShortcuts.ts` |
| IPC / eventing 真边界 | Skill 域 28 通道纳入 `IpcInvokeHandlers`，renderer 走 `invokeSkillIPC`；共享 `protocol.ts` 不再冒充 action 真相源；事件层只保留 `EventBus + InternalEventStore + Mailbox` | `src/shared/ipc/handlers.ts`、`src/renderer/services/invokeSkillIPC.ts`、`src/host/services/eventing/{bus,internalStore}.ts`、`docs/architecture/ipc-channels.md` |
| 桌面启动与首屏 | webServer/renderer/shell 分段打点；release 路径端口清理去重，首屏非必需重库 lazy load；应用内更新在 restart 前用隔离 data dir + 真库快照 best-effort 预热新 bundle compile cache | `src/web/webServerBootstrap.cjs`、`src/web/webServer.ts`、`src-tauri/src/main.rs`、renderer `boot:*` marks、`docs/architecture/desktop-shell.md` |
| 类型与结构门 | 生产 `src/**` 和 `tests/** + scripts/**` 都由 TypeScript 7 native preview 做类型检查，tests/scripts 存量基线已从 1229 降到 0；门自检二进制、配置和零输入，禁止假绿 | `package.json`、`tsconfig.tests.json`、`scripts/tsc-tests-ratchet.mjs`、repository structure/knip/design-system gates |

**架构边界**：

- Durable terminal 是运行事实，session status、SSE、renderer 和外部 adapter 都只能投影它，不能各自再造一个成功/失败判断。
- renderer 允许用唯一同名 streaming placeholder 做受限兼容匹配；稳定 `toolCallId` 一旦存在，禁止按工具名回退。
- `/api/health` 只表示 shell 可以导航。远程 capability 和 durable recovery 在后台继续，durable handler 未 ready 时 agent route 必须返回 503。
- compile-cache warmup 是更新体验优化，失败只退化为冷启动；它不能修改活库、阻塞 restart 或替代真实签名包验收。

详细产品合同见 [Neo Runtime Safety as-built](./plans/2026-07-11-neo-runtime-safety-as-built-spec.md)。

### 2026-06-16 ~ 06-17 迭代治理、事件账本、预算和设计系统契约

这一轮把最近的运行治理、成本可见性和 UI 一致性收成可审计合同。重点是让系统状态从“当前页面看起来如何”转到“有可回放、可对账、可降低基线的事实”。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| 权限决策账本 | `ToolExecutor` 的 allow/deny/ask 决策追加到 `permission_decisions`；写账失败 fail-safe，不影响权限结果 | `src/host/tools/toolExecutor.ts`、`src/host/services/core/databaseService.ts`、`permission_decisions` |
| 工具执行账本 | 工具执行 begin/complete 写入 `tool_execution_events`，重启后可还原崩溃时未闭合工具现场 | `tool_execution_events`、`appendToolExecutionBegin/Complete`、diagnostics IPC |
| Swarm ledger 真理源 | `swarm_run_ledger` 只追加 `run_started / agent_snapshot / run_closed`；旧 rollup 表降级为读缓存，半套账本不当完成态 | `SwarmLedgerRepository.ts`、`swarmLedger.ts`、`swarm-trace-persistence.md` |
| 对账与回填 | reconcile 默认只读扫描，从 ledger 重建值对比 rollup；`rebuildOnDrift` 才写回缓存；老 run backfill 默认不跑，只能 opt-in | `swarmReconcileService.ts`、`backfillSwarmLedger.ts` |
| 静态治理门 | console/a11y/stale-dist 三个轻量静态门接入 CI，配合 lint 防新增漂移 | `scripts/console-scan.mjs`、`a11y-scan.mjs`、`stale-dist-scan.mjs` |
| 设计系统契约 | UI 颜色、按钮和 Modal primitive 进入 machine-checkable 契约；hex 基线归零，handrolled modal/bare button 走 ratchet 收口 | `docs/architecture/frontend.md`、`scripts/check-design-system.mjs`、`design-system-baseline.json` |
| 预算体验 | Settings 暴露预算上限/阈值/周期，运行时按 warning/blocked 边界去重弹 toast，StatusBar cost 跟随预算状态染色 | `BudgetService`、`BudgetSettings.tsx`、`BudgetAlertNotice.tsx`、`CostDisplay.tsx` |
| 工具结果恢复 | 失败工具统一提供复制错误和“从此重试”；auto-loaded retry 与已恢复失败不污染会话状态 | `toolExecutionPresentation.ts`、`ToolCallDisplay` |
| Bash 输出可信度 | 长输出完成后保留头尾，流式进度帧折叠成最终帧；Bash 非 0 退出码即使 result success 也显式标出“判定可能不可靠” | `bashOutputPreview.ts`、`statusLabels.ts` |
| 压缩卡死护栏 | 连续 compaction 后仍超阈值时暂停 auto-compaction，注入收窄任务范围的系统消息，避免重复摘要烧 token | `contextAssembly/compression.ts`、`autoCompressor.ts` |

**架构边界澄清**：

- append-only ledger 是事实源，不是阻塞主流程的强依赖；写账失败必须降级为 warn。
- Swarm ledger 只有闭合 run 才是完成态；`run_started` 后没有 `run_closed` 的半套账本只表示在飞或崩溃现场。
- 预算告警定位是成本可见和范围提醒，不承诺 provider 账单的实时精确拦截。
- 设计系统 gate 是 ratchet 机制，先阻止新增漂移，再按文件分批降低历史基线。

### 2026-06-13 ~ 06-15 会话页、设置页和运行证据门收口

这一轮把最近两天的产品面变化收成三条合同：会话页解释本轮为什么这样运行，设置页承载长期偏好和低频管理，CI/评测门负责防止“能力完成但没有真实证据”。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| 能力证据硬门 | 声称完成的关键能力必须同时有交付物、真实现标记和可复跑证据入口；judge 校准输出混淆矩阵、Kappa、虚高率/误杀率和分歧清单 | `scripts/check-capability-evidence.ts`、`src/host/testing/calibration/judgeCalibration.ts`、`src/host/testing/ci/*` |
| Turn Quality | 每轮输出统一的策略、记忆、能力、工具和交付评分；聊天页用 `TurnQualityStrip` 紧凑展示，Replay Audit 复用同一证据回看 | `src/host/agent/runtime/turnQuality.ts`、`src/shared/contract/turnQuality.ts`、`TurnQualityStrip.tsx`、`ReplayAuditPanel.tsx` |
| 模型策略与可解释决策 | Settings 可配置 fast/main/deep/vision 四档任务模型、fallback 和规则；runtime 产出 task class、cost/speed/tool policy、provider health、fallback trace 和 token savings 诊断 | `shared/contract/settings.ts`、`shared/contract/modelDecision.ts`、`TaskStrategySettingsPanel.tsx`、`modelDecision.ts`、`modelRouter.ts` |
| Composer 入口 | 会话输入区保留高频即时选择：Skills/MCP scope、Auto/Manual routing、当前 agent、session memory、语音输入、模型策略推荐、`/goal` 合同卡、Skill/能力推荐、Appshot chip、prompt command、agent mention；Live Preview 留在会话动作菜单 | `src/renderer/components/features/chat/ChatInput/*`、`SessionActionsMenu.tsx` |
| 语音输入 | 语音按钮只在能力和设置允许时出现，支持本地/云端模式、快捷键触发、转写失败重试、麦克风权限恢复和 silence warning | `VoiceInputButton.tsx`、`useVoiceInput.ts`、`voicePaste.ipc.ts`、`speech.ipc.ts` |
| 快捷键 | 快捷键定义、平台默认值、冲突检测、系统保留组合键提醒、设置页编辑和 renderer 变更事件走同一套 shared contract | `src/shared/keybindings/*`、`KeybindingsSettings.tsx`、`useKeyboardShortcuts.ts`、`globalShortcuts.ts` |
| 媒体与 Artifact | 会话媒体资产、附件预览、文件 artifact 卡片、媒体控制和 lightbox/browser 行为进入聊天消息与 session actions | `sessionMediaAssets.ts`、`MessageBubble/*`、`MediaAssetControls.tsx`、`SessionActionsMenu.tsx` |
| Settings IA | Settings tab id、分组、搜索索引和 access control 统一在 registry；用户管理、控制平面、插件等入口按权限显示 | `settingsTabs.ts`、`settingsIndex.ts`、`SettingsModal.tsx`、`accessControl.ts` |
| 隐私、通道与通知 | 权限边界、凭证库存、诊断包、Browser Relay、语音转写、通道隐私策略和低打扰通知进入设置页可见结构 | `PrivacySettings.tsx`、`ChannelsSettings.tsx`、`permissionBoundary.ts`、`privacyBoundaryIndex.ts`、`platform/notifications.ts` |
| Skills / MCP / Plugins | Skills、MCP、Plugins 与 Capability Center 都有 settings 入口和搜索索引；会话侧推荐可直接挂载已安装 skill 或从推荐库安装 | `SkillsSettings.tsx`、`MCPSettings.tsx`、`PluginsSettings.tsx`、`CapabilityCenterSettings.tsx`、`CapabilitySuggestionStrip.tsx` |
| 项目/会话组织 | Project goal、workspace preview、sidebar project drawer、session metadata、session search jump 和 session asset navigation 把项目与会话分开但可互跳 | `projectService.ts`、`ProjectRepository.ts`、`WorkspacePreviewPanel.tsx`、`SidebarProjectDrawer.tsx`、`workspacePreview.ts` |

**架构边界澄清**：
- 历史竞品研究输入不作为当前产品合同；正式口径以本节和对应架构分册为准。
- Turn Quality 是诊断/复盘信息，不自动阻断普通用户运行。
- Settings 的前端权限只负责入口可见性，管理动作仍以后端 IPC guard、Supabase RLS 和控制平面权限为硬边界。
- 语音输入保持用户主动触发；打开设置页或会话页不会提前请求麦克风权限。

### 2026-06-05 对话式角色、会话自动化和模型设置收口

这一轮把"主聊天里发起长期任务"、"用对话创建/修改持久化角色"和"模型设置保存语义"补成产品合同。当前 `main` 已含模型设置修复；`/schedule`、`/loop`、角色创建/修改在对应本地 worktree 分支，合并时以 2026-06-05 spec 为验收口径。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| `/schedule` 对话式创建 | `/schedule` 空参打开 `ScheduleComposerCard`，用户可选每日简报、缺陷扫描、周回顾或自定义；创建仍走 `cron:generateFromPrompt -> createJob` 单一路径 | `src/renderer/components/features/chat/ChatInput/ScheduleComposerCard.tsx`、`scheduleTemplates.ts`、`src/host/cron/cronService.ts` |
| `/loop` 后台化 | `LoopController` 在启动时登记 `kind='loop'` 的 `BackgroundTaskLedger` 任务，每轮更新进度，终态写 completed/failed/cancelled；自然完成和失败触发 ledger notification + 系统通知 | `src/host/loop/loopController.ts`、`src/shared/contract/loop.ts`、`src/host/task/backgroundTaskLedger.ts` |
| loop meta turns | loop 内部轮次以 `historyVisibility: 'meta'` 写入，事件带 `isMeta`；SQLite `messages.is_meta`、FTS trigger、session count/search/sync 都过滤 meta 和 loop marker | `src/host/services/core/database/schema.ts`、`SessionRepository.ts`、`eventBatcher.ts`、`runFinalizer.ts` |
| 系统通知投递 | main 侧只记录并广播通知请求，renderer 用 Tauri notification plugin 投递，Web 模式 best-effort；`domain:notification/getRecent` 供诊断和 E2E 读取最近通知 | `src/host/services/infra/notificationService.ts`、`src/host/ipc/notification.ipc.ts`、`src/renderer/utils/osNotification.ts` |
| 对话式角色创建/修改 | `create-role` / `edit-role` skill 通过确定性 slash seed 进入；模型调用 `propose_role` 生成草稿，`RoleDraftCard` 由用户确认后才写 `agents/<roleId>.md` 并初始化/保留 `roles/<roleId>/` | `src/host/services/roleAssets/roleDraftQueue.ts`、`src/host/tools/modules/roleAuthoring/proposeRole.ts`、`src/renderer/components/features/chat/ChatInput/RoleDraftCard.tsx` |
| strict skill toolset | 对 role authoring skill 启用 `strictToolset`，把模型可见工具收缩到 allowedTools；deferred-loading 会预加载 active skill 的非 core allowed tools，保证 `propose_role` 可见 | `src/host/tools/skillBoundaryScope.ts`、`deferredToolPreload.ts`、`skillInvocationResolver.ts` |
| 模型设置保存语义 | Provider 连接保存只写 `models.providers[provider]`；点击「设为默认」才写 `models.default/defaultProvider`。左栏文案改成「已可用 / 待添加 Key」 | `src/renderer/components/features/settings/tabs/ModelSettings.tsx`、`ModelSettings.helpers.tsx`、`ProviderListPanel.tsx` |

**架构边界澄清**：

- 角色创建/修改不是直接文件编辑入口。模型只能产出草稿，确认卡 IPC 才能落盘；落盘前必须走内容安全扫描。
- `strictToolset` 是 opt-in，当前用于 `create-role` / `edit-role` 这类 meta skill，不改变普通 skill 的 GAP-001 软边界语义。
- loop 后台化当前是主进程内存运行 + task ledger 镜像，不承诺 app 重启恢复。
- Provider 保存和默认模型设置是两条用户意图，不能在保存连接配置时隐式切默认模型。

### 2026-05-19 Marvis 能力对照补齐：场景化 skill + Vision Framework 工具栈 + Photos connector

这一轮以"对照 Marvis (marvis.qq.com) 八大场景补齐能力广度"为驱动，分发零额外配置走完整链路。架构重点：把 macOS 原生能力（Vision Framework / Photos.app）当作 Agent Neo 的一等公民通过 connector + native binary 接入，**不走 MCP**；同时让 `visionAnalysisService` 终于摆脱硬编码智谱，自动走用户已配的 vision-capable 主 LLM。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| 场景化 builtin skill 扩展 | `BUILTIN_SKILLS` 数组追加 9 个 builtin skill（含触发词中文 description）：`computer-housekeeper`（系统清理/网络修复）、`contract-review`（10 维度风险点）、`literature-review`、`paper-distillation`（带页码定位）、`research-monitor`（cron + 飞书推送）、`image-ocr-search`、`data-analysis-helper`、`meeting-summary`、`photo-archive`；编译进 binary 所有用户开箱即用 | `src/host/services/skills/builtinSkills.ts` |
| Capability Center 对外展示 | `docs/capabilities/local-curated-registry.json` 新增 9 个 `workflow_recipe` 卡片对应上述 builtin skill；每张卡片 `audit.notes` 标注对应的 skill name；`source.contentHash` 重算（sha256:4d515295...） | `docs/capabilities/local-curated-registry.json` |
| vision-ocr Swift 工具 | macOS Vision Framework `VNRecognizeTextRequest` 中英文 OCR，零配置零云端；CLI `--photo <path> [--languages zh-Hans,zh-Hant,en-US]`，输出 JSON 含 fullText + regions（boundingBox 转左上原点像素坐标）；体积 95KB | `scripts/vision-ocr.swift`、`scripts/build-vision-ocr.sh` |
| vision-tagger Swift 工具 | `VNDetectFaceRectanglesRequest` + `VNGenerateImageFeaturePrintRequest`（人脸特征向量 base64）+ `VNClassifyImageRequest`（ImageNet 1000 类）；CLI `--mode face\|classify\|all`；体积 116KB | `scripts/vision-tagger.swift`、`scripts/build-vision-tagger.sh` |
| `ocr_search` native tool | spawn `vision-ocr` binary，OCR 结果入 memories 表（`type='ocr_result'`、`category='screenshot_ocr'`、`source='vision_ocr'`），metadata 存图片路径 + regions + 平均置信度；后续可用 memory_search 按文字反向搜历史截图 | `src/host/tools/modules/vision/ocrSearch.ts`、`ocrSearch.schema.ts` |
| `photo_archive` native tool | 包装 `photoLibraryTagger.archiveAlbum`，agent 调用一次完成"导出 → vision-tagger 批量 → 人脸聚类 → 入库 → 清理"整条链路，返回 `{ processed, faceCount, clusters[], topThemes[], memoryIds[] }` | `src/host/tools/modules/vision/photoArchive.ts`、`photoArchive.schema.ts` |
| Photos.app native connector | 新增 `photos` 连接器（跟 mail/calendar/reminders 同形态），暴露 `list_albums` / `list_photos` / `export_photos` / `get_status` / `probe_access` / `repair_permissions` 6 个 action；用 unit/record separator 而非 `|` 避免相册名特殊字符冲突；首次访问触发 macOS 自动化授权弹窗，readiness 状态机管理 unchecked/ready/failed/unavailable | `src/host/connectors/native/photos.ts`、`src/host/connectors/registry.ts`、`src/shared/constants/misc.ts`（NATIVE_CONNECTOR_IDS 扩展） |
| photoLibraryTagger service | 编排 `photos.export_photos` → 顺序 spawn vision-tagger → cosine similarity 并查集聚类（默认阈值 0.6）→ 主题分类聚合 → 入 memories 表 → 清理临时目录；featurePrint 走 Float32Array view 不拷贝 buffer；失败照片计入 `failed` 不阻塞整体 | `src/host/services/desktop/photoLibraryTagger.ts` |
| `visionAnalysisService` 走 ModelRouter | 重写 `analyzeImageWithVisionDetailed`：从硬编码智谱 fetch 改为 `getModelForCapability('vision')` + `ModelRouter.getModelInfo(supportsVision)` + `inferenceWithVision`；自动适配 GPT-4o / Claude / Gemini / GLM-4.6V / Qwen-VL / MiMo-VL / Doubao-VL / Kimi 视觉等所有 vision-capable 主 LLM；用 `Promise.race(timeoutController)` 处理 timeoutMs | `src/host/services/desktop/visionAnalysisService.ts` |
| MemoryRecord type 扩展 | union 加 `ocr_result` + `photo_archive` 两个新类型，双 source-of-truth 同步：`src/host/protocol/types/repositories.ts` + `src/shared/ipc/types.ts` | 两边都改 |
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
| Agent Neo 品牌层 | Tauri bundle、icon、Info.plist、MCP server、terminal、About/Update 和 landing page 文案切到 Agent Neo；仓库名与历史文档名继续保留 Code Agent | `src-tauri/tauri.conf.json`、`src-tauri/icons/*`、`public/code-agent/index.html`、`src/host/prompts/identity.ts` |
| 本地模型配置 | 删除 server-side `cloud-proxy` provider；`ModelSettings` / onboarding 引导用户配置本地 API Key；模型请求由 `modelConfigResolver` 和 provider wrappers 读取本机配置 | `src/host/agent/orchestrator/modelConfigResolver.ts`、`src/host/model/modelRouter.ts`、`src/renderer/components/onboarding/ModelOnboardingModal.tsx`、`src/renderer/components/features/settings/tabs/ModelSettings.tsx` |
| Agent Engine 抽象 | `AgentEngineKind = native / codex_cli / claude_code / mimo_code / kimi_code`（2026-06-22 加 MiMo/Kimi）；外部 engine 检测版本、生成 descriptor、通过 `codex exec --json`、`claude -p --output-format stream-json --permission-mode plan`、`mimo run --format json` 或 `kimi -p --output-format stream-json` 运行，并把事件归一为 session engine metadata。完整 as-built（兼容矩阵/billingMode/设置页 IA）见 [agent-engine.md](./architecture/agent-engine.md) | `src/shared/contract/agentEngine.ts`、`src/shared/constants/engineCompat.ts`、`src/host/services/agentEngine/*`、`src/host/ipc/agentEngine.ipc.ts`、`src/web/routes/agent.ts` |
| 外部 engine 安全边界 | 外部 engine 只允许 manual chat session、workspace cwd 内、read-only permission profile；启动命令、cwd、log path 和 output refs 写入 task ledger | `src/host/services/agentEngine/agentEngineGuards.ts`、`codexCliAdapter.ts`、`claudeCodeAdapter.ts`、`src/host/task/backgroundTaskLedger.ts` |
| Agent Engine UI | ModelSwitcher 合并模型、reasoning effort 和 engine 选择；Capability Center 把 agent engine 当成能力卡，展示安装/运行/权限/风险状态 | `src/renderer/components/StatusBar/ModelSwitcher.tsx`、`src/host/services/capabilities/agentEngineCapabilityItems.ts`、`CapabilityCenterSettings.tsx` |
| 会话历史导入 | Codex / Claude jsonl 历史可扫描、预览、标准化，供接力、复盘和 review 使用 | `src/host/services/agentEngine/agentEngineHistoryImport.ts` |
| Capability Center 本地 registry | `CapabilityKind` 扩到 `agent_engine / skill / mcp_template / tool_bundle / channel_adapter / workflow_recipe / connector`；本地 curated registry 生成 disabled MCP draft，支持删除和回滚 | `src/shared/contract/capability.ts`、`docs/capabilities/*`、`src/host/services/capabilities/*`、`src/renderer/hooks/useCapabilityInventory.ts` |
| 统一记忆管理 | memory import、knowledge inbox decision、memory entry runtime、injection trace、seed injector 与 Settings Memory UI/Knowledge Memory Panel 打通 | `src/host/memory/*`、`src/host/ipc/memory.ipc.ts`、`src/renderer/components/features/settings/tabs/MemoryTab.tsx`、`KnowledgeMemoryPanel.tsx` |
| In-App HTML Validation | `validate_html_in_app` 作为 vision tool 调起 renderer 右侧 iframe 面板，复用 `BrowserInteractionStep` DSL 执行 click/hover/type/press/wait 与 expect 断言 | `src/host/tools/modules/vision/validateHtmlInApp.ts`、`src/shared/contract/browserInteraction.ts`、`src/host/services/inAppValidationService.ts`、`InAppValidationPanel.tsx` |
| Managed Browser Surface | Browser relay extension、`BrowserRelayService` 和 `BrowserSurfacePanel` 让托管浏览器从底层工具变成可查看 sidecar 面板 | `resources/browser-relay-extension/*`、`src/host/services/infra/browserRelayService.ts`、`src/renderer/components/features/browser/BrowserSurfacePanel.tsx` |
| Background Task Ledger | shell/background task、PTY 和外部 engine 输出进入统一 `Task / TaskEvent / TaskNotification / TaskOutputRef` 合同，当前 session 可 drain 通知并打开输出引用 | `src/shared/contract/backgroundTask.ts`、`src/host/task/backgroundTaskLedger.ts`、`backgroundTaskLedger.ipc.ts`、`useBackgroundTaskSync.ts` |
| Handoff proposals | runtime 在长任务尾部生成 handoff proposal stream，TaskPanel 通过 `HandoffCard` 展示可接力摘要 | `src/host/handoff/*`、`src/host/prompts/handoff.ts`、`src/renderer/components/TaskPanel/HandoffCard.tsx` |
| Artifact repair Route A | artifact repair 改为 full-rewrite-first；repair admission/guard/context assembly 继承 baseline 和 failures，P3 monotonic gate 阻止无界修复循环 | `src/host/agent/runtime/artifactRepair*`、`src/shared/constants/repair.ts`、`scripts/acceptance/platformer-gameplay-generation.ts` |
| Settings / Admin guard | Settings 增加 Workspace、Automation、Data、Model、Capability、管理页；admin IPC 统一走 `adminGuard`，用户 dashboard 与邀请码由 Supabase RPC 支撑 | `src/renderer/components/features/settings/*`、`src/host/ipc/adminGuard.ts`、`src/host/services/admin/adminService.ts`、`supabase/migrations/20260516000000_user_invite_management.sql` |
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
| Agent Engine 签名模型目录 | 控制面新增 `agent_engine_model_catalog` artifact；主进程验 Ed25519 envelope，失败回退内置 catalog；`ModelSettings` 保存本机默认模型，`ModelSwitcher` 对 Codex/Claude 展示 catalog 模型，不混进普通 Provider 模型 | `src/host/services/agentEngine/agentEngineModelCatalog.ts`、`src/shared/agentEngineModelCatalog.ts`、`src/renderer/components/StatusBar/ModelSwitcher.tsx`、`src/renderer/components/features/settings/tabs/ModelSettings.tsx` |
| 外部 engine 模型执行 | session engine metadata 增加 `model`；Codex CLI 通过 `codex exec --model ...`，Claude Code 通过 `claude -p --model ...`；选择 engine 时同时保存 workspace cwd，防止外部 CLI 从错误目录启动 | `src/shared/contract/agentEngine.ts`、`agentEngineGuards.ts`、`codexCliAdapter.ts`、`claudeCodeAdapter.ts`、`src/renderer/stores/sessionStore.ts` |
| 显式模型降级边界 | `ModelRouter` 和 vision capability fallback 只在 `modelConfig.adaptive === true` 时跨 provider fallback；用户点选具体模型时，失败应暴露原 provider 错误，不再自动换模型 | `src/host/model/modelRouter.ts`、`src/host/agent/runtime/contextAssembly/inference.ts`、`src/host/session/modelSessionState.ts` |
| Web 会话持久化健康 | `/api/health` 返回 `persistence`；状态栏和 Data Settings 在 SQLite 不可用时显示“历史未持久化”；新增 acceptance smoke 验证 webServer 重启后 session 可恢复 | `src/web/routes/health.ts`、`src/web/helpers/sessionCache.ts`、`src/renderer/components/StatusBar/PersistenceStatus.tsx`、`scripts/acceptance/session-persistence-smoke.ts` |
| macOS 包内置 Node | release/prebuild 准备 `dist/bundled-node/bin/node`；Tauri release 优先用包内 Node 启动 webServer，并在 release verify 阶段用同一 Node 加载 `better-sqlite3.node` | `scripts/prepare-bundled-node.mjs`、`src-tauri/src/host.rs`、`src-tauri/tauri.conf.json`、`scripts/verify-macos-release.sh` |
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
| Context Health Token 溯源 | `TokenBreakdown` 新增 `bySource`（rules / skills / mcp / subagents / fileReads / conversation 六维）；`ContextHealthService.recordSourceContribution(sessionId, source, tokens, mode)` 支持 add/set，`clearSourceContribution` / `resetSourceContributions` / `clearMcpServerAcrossSessions` 负责卸载与压缩后清零；200ms 防抖广播 `context:health:event` | `src/host/context/contextHealthService.ts`、`src/shared/contract/contextHealth.ts` |
| Token 上报点 | skill mount/unmount（`sessionSkillService`）、SessionStart AGENTS.md 注入（`agentsHooks`）、fileRead（`read.ts`）、MCP 工具结果（`mcpInvoke`）、subagent 输出（`task.ts` / `spawnAgent.ts`）统一调用 `recordSourceContribution` 上报 token 占用 | `src/host/services/skills/sessionSkillService.ts`、`src/host/hooks/agentsHooks.ts`、`src/host/tools/modules/*` |
| Context Panel UI | workbench 新增 `context` tab，`ContextPanel` 容器挂载 `ContextHealthPanel`；一级展开按消息结构（systemPrompt / messages / toolResults / toolDefs），二级展开按产品来源并支持 Skills/MCP/Subagents 嵌套折叠；每项提供跳转（联动 SkillsPanel highlight）和 ✕ 卸载（MCP 走 `setServerEnabled` IPC，skill 走 unmount） | `src/renderer/components/ContextPanel.tsx`、`src/renderer/components/ContextHealthPanel.tsx` |
| 取消级联契约 | `CancellationReason` 区分 CASCADE（`user-cancel` / `session-switch` / `parent-cancel`，触发 `spawnGuard.cancelAll()`）与 NON_CASCADE（`child-error` / `timeout` / `idle-timeout` / `budget-exceeded`，只影响单 agent）；单个 child 抛错不波及兄弟 | `src/shared/contract/cancellation.ts` |
| 四阶段 Shutdown | `initiateShutdown` 走 Signal（abort）→ Grace（5s 等工具收尾）→ Flush（2s 经 TeamManager 持久化 findings）→ Force（返回 partial results）；idle watchdog 监测 2 分钟无 stream/progress 自动 `abort('idle-timeout')` | `src/host/agent/shutdownProtocol.ts`、`src/host/agent/subagentExecutor.ts` |
| Per-agent Stop UI / 信号桥接 | `SwarmMonitor` 每个 agent 卡片可独立 Stop，走 `swarm:cancel-agent` IPC（`spawnGuard.cancel` 或 `parallelCoordinator.abortTask`）；`subagentExecutor` 用 `createChildAbortController` 把 parent abortSignal 与内部 timeout 单向桥接到子控制器，child abort 不反向传播 | `src/renderer/components/features/swarm/SwarmMonitor.tsx`、`src/host/ipc/swarm.ipc.ts`、`src/shared/constants/timeouts.ts`（`CANCELLATION_TIMEOUTS`） |
| Computer-use MCP 入口归位（Level 1） | Computer + Screenshot 包装成 native ToolModule（`computer.ts` + `computer.schema.ts`），统一走 MCP 工具入口；handler 做权限检查后委托 legacy `ComputerTool.execute`，结果经 `adaptVisionLegacyResult` 适配。当前是 wrapper-mode，占位到 ToolModule 协议层，为后续 Level 2 原生重写留接口 | `src/host/tools/modules/vision/computer.ts`、`computer.schema.ts` |
| Workbench 诊断面板群 | Context Health、Knowledge Memory Audit（`KnowledgeMemoryPanel` + `memory.ipc.ts` 的 `MemoryAuditRequest`/`serializedAuditMemory`）、Activity Entry（`ActivityPanel` + `activityContextProvider`）、Computer-use Diagnostics（`computerUseWorkbench.ts` + `computerSurface.ts`）、Time Capability（集中读 `timeouts.ts`）五类诊断面板进入聊天主链路；Workspace Preview 露出活动与工作区产物（`WorkspacePreviewPanel` + `memoryActivityNavigation`） | `src/renderer/components/features/{knowledge,activity}/*`、`src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/utils/computerUseWorkbench.ts` |
| Runtime Steer | 运行中途用户输入经 `steer()` → `messageProcessor.injectSteerMessage()` 排队进当前轮次消息历史并持久化，置 `needsReinference=true` 下轮推理；guided UI 用 `RuntimeInputDelivery` 元数据标记 `queued_next_turn`；web host follow-up 在 `/web/routes/agent.ts` 接 `clientMessageId` 字段供 prompt rewind 溯源 | `src/host/agent/runtime/conversationRuntime.ts`、`messageProcessor.ts`、`src/web/routes/agent.ts` |
| Vision 模型切换 | `ZHIPU_VISION_MODEL` 切到免费档 `glm-4.1v-thinking-flash`（带推理链），8 个视觉模块（视觉分析 / 图像标注 / 截图 / PPT 生成等）统一从常量读取 | `src/shared/constants/models.ts` |
| Context builder 工作目录边界 | 系统提示新增 `workingDirBoundaryInfo` 块，澄清三点：工作目录是相对路径基准而非任务边界、系统级查询可访问 home 绝对路径、续接指令保留上文任务作用域 | `src/host/agent/messageHandling/contextBuilder.ts` |
| Channel / 本地活动隐私防火墙 | 渠道入站消息与本地桌面活动在落地/分发前统一脱敏：`channelPrivacyFirewall` 三模式（local-redact/allow-raw/off）+ 飞书 `feishuPrivacy` 接入 + `ChannelsSettings` 策略 UI；`localActivityPrivacyFirewall` 脱敏 `DesktopActivityEvent` 字段，`screenshotPrivacyRedactor` 用 sharp 做截图区域级 blur；`sensitiveDataGuard` 补 SSN / 信用卡（Luhn 校验）确定性 PII 脱敏；`native_desktop.rs` Rust 侧对称脱敏（URL 凭证 / home 路径 / email / 信用卡 Luhn） | `src/host/channels/privacy/channelPrivacyFirewall.ts`、`src/host/services/activity/localActivityPrivacyFirewall.ts`、`src/host/services/activity/screenshotPrivacyRedactor.ts`、`src/host/security/sensitiveDataGuard.ts`、`src-tauri/src/native_desktop.rs` |

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
| Prompt Registry | `applyOverride()` 将 prompt 常量包成实时字符串；`dynamic()` 让组合 prompt 每次构建都重新读取 override；`promptIndex` 负责副作用注册所有 prompt 模块 | `src/host/prompts/registry.ts`、`src/host/prompts/promptIndex.ts`、`src/host/prompts/builder.ts` |
| Prompt Manager UI | `domain:prompt` 提供 `list/get/set/reset/preview/debugSystemPrompt`；UI 按 category 展示默认文本和当前生效文本，保存到 `~/.code-agent/prompts-overrides/<id>.md` | `src/host/ipc/prompt.ipc.ts`、`src/renderer/components/features/prompts/PromptManagerModal.tsx` |
| Hook Settings | `domain:hook` 汇总全局/项目 hook 配置、enabled/unused events、matcher、source、decision/observer、parallel，并能创建/打开/定位配置文件 | `src/host/ipc/hook.ipc.ts`、`src/renderer/components/features/settings/tabs/HooksSettings.tsx` |
| Hook Activity in Chat | HookManager 记录最近 50 条 trigger history，并通过 turn timeline 注入 `hook_activity`；TurnCard 在用户提示词下方展示本轮 hook 数量、状态、耗时和事件 chips | `src/host/hooks/hookManager.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`src/renderer/components/features/chat/TurnCard.tsx` |
| CLI hooks 默认启用 | CLI `buildCLIConfig()` 显式设 `enableHooks:true`，`AgentLoop` 不再只在 planning mode 下运行用户 Hook | `src/cli/bootstrap.ts`、`src/cli/types.ts` |
| Chat workspace defaults | 新建会话、新 tab、初始 bootstrap 传 `workingDirectory:null`，避免继承上一条代码工作区；TitleBar 选择目录后通过 `session:update` 持久化 | `src/renderer/components/Sidebar.tsx`、`src/renderer/components/TitleBar.tsx`、`src/renderer/stores/sessionStore.ts` |
| Prompt Rewind | `domain:session/rewindToPrompt` 拒绝 running session，找到锚点用户消息与最近 checkpoint，回滚文件，隐藏锚点及之后 active 消息，把原 prompt/attachments 回填输入框，并写 `session_rewinds` 审计 | `src/host/app/agentAppService.ts`、`src/host/services/core/repositories/SessionRepository.ts`、`src/host/services/checkpoint/fileCheckpointService.ts`、`src/renderer/components/ChatView.tsx` |
| Web 模式对齐 | `src/web/webServer.ts` 增加同名 `rewindToPrompt` action，Web 端会话 API 与 Tauri IPC 保持功能一致 | `src/web/webServer.ts` |

**持久化边界**：
- `messages.visibility = active | rewound` 是 active transcript 的过滤条件；rewound 消息保留在库中用于审计、同步和回放，不再出现在普通 `getMessages()`。
- `session_rewinds` 记录 anchor prompt、隐藏消息列表、checkpoint message、文件恢复/删除数量和错误列表。
- Supabase 侧迁移 `20260511000000_prompt_rewind.sql` 同步增加 `messages.visibility` 与 `public.session_rewinds`，并用 RLS 限制到当前用户。

### v0.16.72-73 Native Protocol + Artifact Acceptance + Isolation + Quality Gates（2026-05-01 ~ 2026-05-10）

这一轮同时推进工具协议、artifact 验收、多 agent 浏览器/桌面隔离、类型/异步/清理门禁。文档口径按能力域记录，避免把它误读成零散 refactor。

| 能力域 | 当前闭环 | 关键文件 / 文档 |
|------|---------|----------------|
| Level 1 native tool protocol | Web/Search、Excel、Document、MCP、Skill、LSP、Multiagent、Planning、Vision、Network/Media/Docgen/PPT 按 wave 迁到 native module；旧 wrappers/legacy path 分批删除；IPC schema 不变的工具保留前端兼容 | `src/host/tools/modules/*`、`src/host/tools/registry.ts`、`docs/migrations/legacy-tools-removal-sop.md` |
| Tool reliability | WebFetch 强制 URL；toolSearch 无 callable 命中时明确失败；Edit old_text mismatch 返回最近 anchor lines；LSP 扩到 100+ extension map 并能返回 install hint；shell 统一走 command policy | `src/host/tools/modules/network/*`、`src/host/tools/utils/anchorHint.ts`、`src/host/lsp/*`、`src/host/tools/modules/shell/commandPolicy.ts` |
| Runtime / Web / Context hardening | compaction/browser recovery、partial-failure trace、Web 401/403 token mismatch recovery、run 前持久化 user message、activeAgentLoops flush、telemetry classifier、token-trigger compaction、context fill 包含 tool schemas | `src/host/context/*`、`src/web/webServer.ts`、`src/host/telemetry/*`、`src/renderer/components/features/chat/*` |
| Artifact acceptance / repair | 通用 repair toolkit、Game subtype registry、Best-of-N + repair cap + monotonicity gate、DeckVerifier + schema/narrative probes、DashboardVerifier + browser visual smoke + state_change_on_click probe；产品级质量状态进入 ArtifactIssue / EvalReplayQualityReport / Admin Review Queue；旧 AcceptanceRunner / Delivery Review / Preview Feedback 已下线 | `src/host/agent/runtime/repair/*`、`src/host/agent/runtime/game/*`、`src/host/agent/runtime/deck/*`、`src/host/agent/runtime/dashboard/*`、`src/shared/contract/productClosure.ts`、`src/host/services/core/repositories/ArtifactIssueRepository.ts` |
| Browser / Computer multi-agent isolation | 子 agent 工具调用带 `agentId`，BrowserService pool 提供 per-agent cookie/storage 隔离；ephemeral Chromium FIFO semaphore；ComputerSurface 写动作 mutex；新增 mouse_down/up、open_application、write_clipboard、computer_batch、hold_key、triple_click、cursor_position | `src/host/services/infra/browserPool.ts`、`src/host/services/infra/browserService.ts`、`src/host/services/infra/playwrightLaunchSemaphore.ts`、`src/host/services/desktop/computerSurfaceLock.ts`、`src/host/tools/vision/computerUse.ts`、`tests/smoke/*` |
| Multi-agent signal propagation | subagent dispatch 将 `agentId` 注入 `ToolContext`；`effectiveSignal` 透传 `modelRouter.inference`，避免子 agent cancel / abort 丢到模型调用外 | `src/host/agent/multiagentTools/*`、`src/host/model/modelRouter.ts` |
| Typed IPC / Web payload | `shared/ipc` zod schemas、`defineHandler`、renderer `typedInvoke`、web `parseBody` 建成 typed IPC/HTTP payload 校验起点 | `src/shared/ipc/*`、`src/host/platform/ipcRegistry.ts`、`src/renderer/services/typedInvoke.ts`、`src/web/helpers/typedBody.ts` |
| Provider wrappers / symmetry | OpenAI / Anthropic / DeepSeek / Gemini 解析走 zod wrappers，SSE stream 切到 wrappers；51 fixtures contract tests；provider symmetry 脚本接 Husky + GitHub Actions | `src/host/model/providers/wrappers/*`、`scripts/check-provider-symmetry.sh`、`.husky/pre-commit` |
| Async correctness / god-file split | `Promise.race` → `withTimeout`，timer graceful shutdown + `.unref()`，`new URL()` try/catch；HookManager / telemetryQueryService / TaskDAG 按执行引擎、replay、graph algorithms 拆分 | `src/host/services/infra/timeoutController.ts`、`src/host/hooks/*`、`src/host/evaluation/*`、`src/host/agent/taskDag.ts` |
| Cleanup / architecture retirement | cloud agent module、legacy provider functions、P0-5 POC subsystem、Decorated tools、orphan resume、unused exports 清理；Message 类型统一到 `shared/contract`；Codex sandbox/crossVerify 退场，改成 bash command policy | `src/host/agent/*`、`src/host/model/*`、`src/host/tools/*`、`src/shared/contract/*` |

**架构边界澄清**：
- Native protocol migration 是运行时入口归位，不改变用户看到的工具语义；同名工具、alias 和 IPC contract 尽量保持兼容。
- Artifact acceptance 采用"按 artifact kind 拥有自己的 verifier"的策略；ADR-016 明确暂不抽 `ArtifactKindVerifier` 顶层接口，避免把 deck 的 in-memory 验证和 dashboard 的 browser 验证硬塞进同一形态。
- Browser/Computer 隔离解决的是 Agent Team 并发时的状态串扰，默认单 agent 浏览器语义保持不变。
- 5/10 的 cleanup 是架构退休：删除不再 active 的 POC/cloud/legacy path，不作为新产品入口宣传。

### v0.16.66 Agent Runtime Capability Hardening (2026-04-27)

这一轮把 2026-04-27 的 P1/P2 capability audit 从计划推进到代码和定向测试闭环。范围集中在 agent runtime、tool、MCP、persistence、swarm、eval/replay 的生产链路。

| 模块 | 当前闭环 | 关键文件 |
|------|---------|---------|
| Run lifecycle | `ConversationRuntime.run` 统一 terminal path；`completed / failed / cancelled / interrupted` 都进入 `RunFinalizer`；cancel 发 `agent_cancelled`，failure 不绕过 finalizer | `src/host/agent/runtime/conversationRuntime.ts`、`runFinalizer.ts` |
| Run-level abort | `abortSignal` 贯穿 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> ProtocolToolContext`，长 Bash/http 等工具可被 run cancel | `src/host/agent/runtime/toolExecutionEngine.ts`、`src/host/tools/toolExecutor.ts`、`src/host/tools/dispatch/toolResolver.ts` |
| Chat run owner | desktop chat send/interrupt 走 TaskManager-owned path，避免 chat status 与 task state 两套 owner 漂移 | `src/host/app/agentAppService.ts`、`src/host/task/TaskManager.ts` |
| Tool 权限与 MCP | `Bash/bash` 归一；顶层审批结果通过 `approvedToolCall` 传给 resolver；MCP dynamic tool 可 direct execute 到 `MCPClient.callTool`；ToolSearch 标记 `loadable/notCallableReason` | `toolExecutor.ts`、`toolResolver.ts`、`mcpToolRegistry.ts`、`toolSearchService.ts` |
| Skill 安全边界 | project/user skill 的 `allowed-tools` 不再自动扩权；只有 builtin/plugin skill 可进入自动 preapproval | `src/host/tools/modules/skill/skill.ts`、`src/host/services/skills/skillParser.ts` |
| Multiagent | parallel executor 有真实 inbox；`dependsOn` 按成功依赖门控；失败/blocked/cancelled 都进入 aggregation；run-level cancel 阻止 pending agent 启动 | `parallelAgentCoordinator.ts`、`sendInput.ts`、`resultAggregator.ts` |
| 持久化恢复 | todo、Task tool task、context intervention、compression state、persistent system context、pending approval kind hydrate 都有 session-scoped durable path | `SessionRepository.ts`、`taskStore.ts`、`contextInterventionState.ts`、`runtimeStatePersistence.ts` |
| Replay / Eval | structured replay join model/tool/event evidence；`real-agent-run` gate 校验 `sessionId + replayKey + telemetryCompleteness`，缺关键证据会 fail/degraded | `telemetryQueryService.ts`、`testRunner.ts`、`ExperimentRunner.ts` |

验证口径：P1/P2 计划文档列出的 blocker 已在 unit/renderer/security 定向测试和 `npm run typecheck` 层面闭环；真实 app 长 run pause/resume、UI cancel 长命令、Agent Team 多 agent、reload recovery 仍按 smoke 风险列在对应文档里，不写成已完成的产品验收。

### v0.16.67-71 Hardening + 评测扩面 + Design Brief 生产化（2026-04-27 ~ 2026-04-29）

两天的 50+ commits 集中在：基建守门、安全收口、目录归位、新模型接入、Design Brief 全链路、评测扩面、调试快照与 CLI debug 命令树、channel 实时事件。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Tauri Updater 安全 (M6.a / M6.b) | cloud-api 下发 `sha256` 字段；updater 落盘前哈希校验；`open_update_url` 阻止二进制下载，仅可在浏览器打开 release 页 | `src/host/services/updater/*`、`vercel-api/`、`docs/releases/` |
| Updater artifact 关闭 | `tauri.conf.json` 关闭自动 updater artifact 生成，避免无签名/无哈希产物意外发布 | `src-tauri/tauri.conf.json` |
| EventBus / EventBridge 归位 | 事件运行时从 `src/host/protocol/` 迁到 `src/host/services/eventing/`，`vi.mock` 路径同步更新；事件分层与三通道契约不变 | `src/host/services/eventing/*`、`tests/eventing/*` |
| Tool dispatch 归位 (M1.2) | tool 分发从 `protocol/` 拆出，统一到 `src/host/tools/dispatch/`，`ToolResolver` 与 abort 链贯通保持原状 | `src/host/tools/dispatch/toolResolver.ts` |
| 调试快照体系 (ADR-014) | `turn_snapshots` + `compaction_snapshots` 两张表 + 写入器；step pause；settings "调试快照" section 含 retention selector；`data` 域 IPC 暴露 stats/clear/setRetention；CLI `code-agent debug` 命令树复用同一能力 | `src/host/agent/runtime/turnSnapshotWriter.ts`、`src/host/context/compactionSnapshotWriter.ts`、`src/host/ipc/data.ipc.ts`、`src/cli/commands/debug/*` |
| 本地 Ollama 评测 (ADR-013) | 评测中心 `MODEL_OPTIONS` 显式声明 provider；`evaluation.ipc.ts` 接收 provider 字段并按 provider 路由 API key；主聊天 `ModelSwitcher` unhide local provider。**评测中心 UI 与 `evaluation.ipc.ts` 已于 v0.16.79 移除**，主聊天 `ModelSwitcher` 的 local provider 仍在 | `src/renderer/components/StatusBar/ModelSwitcher.tsx` |
| `evalEligible` catalog 字段 | `model-catalog.json` 标记可评测模型，`CreateExperimentDialog` 模型列表从 `PROVIDER_MODELS` 派生并按 `evalEligible` 过滤，避免视觉/嵌入模型出现在主聊天打分对象里 | `src/shared/model-catalog.json`、`src/shared/constants/models.ts` |
| SWE-bench docker harness (ADR-015) | 独立 `benchmarks/swe-bench/`，colima + 官方 docker image；`validation.ts` 双层 executable validation；CLI `--mode docker \| python` 默认 docker；Django <15min 子集 9/10 first-shot；不污染 chat agent 主链路 | `benchmarks/swe-bench/*` |
| 小米 MiMo provider | 新增 `XiaomiProvider`（OpenAI 兼容，新加坡 token-plan 节点），注册 4 个模型（mimo-v2.5-pro / v2.5 / v2-pro / v2-omni 多模态）；`DEFAULT_PROVIDER` 切到 `xiaomi`，`DEFAULT_MODEL` 切到 `mimo-v2.5-pro`；CLI / IPC / Web 各入口注册 `XIAOMI_API_KEY` env | `src/host/model/providers/xiaomiProvider.ts`、`src/shared/constants/providers.ts`、`src/shared/constants/defaults.ts`、`scripts/acceptance/xiaomi-smoke.ts` |
| 模型 capability/缩写 单源真理 | 散落在前后端的 capability map 与缩写映射收敛到 `src/shared/constants/models.ts`，前端只消费派生视图 | `src/shared/constants/models.ts` |
| SessionManager apiKey 剥离 | HTTP response 经 `SessionManager` 出口前显式 strip `ModelConfig.apiKey`，防止云同步 / Web 模式回传链路把密钥泄漏到 renderer 或日志 | `src/host/session/SessionManager.ts` |
| Audit Phase A (命令注入 + 默认模型硬编码) | 长期遗留 shell 拼接路径全部走 `execFile`；多处 `\|\| 'deepseek'` `\|\| 'kimi-k2.5'` 风格的硬编码 fallback 全部替换为 `DEFAULT_PROVIDER` / `DEFAULT_MODEL` 常量 | `src/host/`（多文件）；自检 `grep -rn "\|\| 'deepseek'"` |
| NetworkStatus closure-stale 修复 | `NetworkStatus` 闭包陈旧导致退避少一档，调整为读最新 state 而非 closure 捕获 | `src/host/network/networkStatus.ts` |
| `silenceAsync` observability helper | 新增 `silenceAsync` 包装高频 fire-and-forget 调用，6 处关键审计链路接入避免日志爆炸但保留诊断断点 | `src/host/utils/silenceAsync.ts` |
| Husky + lint-staged + 硬编码自检 | 提交前自动跑 `grep -rn "\|\| 'deepseek'"` 等自检规则，硬编码常量回潮即拦截 | `.husky/pre-commit`、`package.json` |
| `max-lines: 1000` ESLint 守门 | 1000 行上限作为 God File 硬护栏，19 个 legacy God File 进白名单逐步消化 | `eslint.config.js` |
| Supabase services 类型清理 | 一次性移除 18+ 处 `as any`，并修出 latent bug（B5 audit） | `src/host/services/sync/*` |
| Design Brief 生产化 (Phase A→C.3) | `src/design/`（direction-tokens + 5-dim critique）、`src/artifacts/question-form.ts`、`src/host/prompts/selfCritique.ts`、`src/host/prompts/questionForm.ts`、`src/host/app/workbenchTurnContext.ts` 把 brief 生产路径接进 envelope 与 system prompt；C.3 路线 A 借鉴 nexu-io 模式注入 silent self-critique pre-emit gate | `src/design/*`、`src/artifacts/*`、`src/shared/contract/designBrief.ts`、`src/host/prompts/selfCritique.ts` |
| Workspace Preview Panel | 右侧 artifact workbench：承载 designBrief / questionForm / design_ppt / Prompt Apps / Gallery；产品级质量状态已迁到 ArtifactIssue / Admin Review Queue，旧 delivery review / preview feedback 已下线 | `src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/components/QuestionFormPreview.tsx`、`src/renderer/hooks/useWorkspacePreviewModel.ts`、`src/renderer/utils/workspacePreview.ts` |
| Channel inbox / outbox 实时事件 | 入站 / 出站事件统一 IPC 通道，renderer 可 `list / dismiss`；当前 UI 入口由 TaskMonitor / 任务分解视图承接能力状态与事件摘要 | `src/host/channels/*`、`src/renderer/components/TaskPanel/TaskMonitor.tsx` |
| Chat-view 新会话首屏 | 新 session 首屏从"示例 prompt 卡"改为写邮件/排日程、做方案/文档/PPT、调研/对比、代码改动四类具体任务入口 | `src/renderer/components/ChatView.tsx` |
| ~~Eval Center Review Queue~~（v0.16.79 移除）| `SessionListView` 把待评 session 集中分桶，标注 replay 完整度与异常 case；行点击进详情；fatal inference error 熔断；DB 去重 | 整套 evalCenter UI + `testRunner.ts` 已随 evaluation 子系统删除 |
| Computer Surface `locate_role+targetApp` | 走 macOS background AX 直连指定 app 控件树，避免唤起前台；`type` / `key` 没有 background target 时降级前台键盘事件，bridge 显式 warn；文档 Computer / computer_use 别名映射 + 截图可见性规则 | `src/host/tools/computerUse.ts`、`src/host/tools/desktop.ts`、`docs/guides/computer-use.md` |
| Computer Use 底座 = cua-driver（ADR-021） | **桌面 App 走 cua-driver（stdio MCP，AX 树优先 + 双平台后台），浏览器走 Playwright `browser_action`，按任务类型分流不做运行时 fallback**。`CODE_AGENT_ENABLE_CUA=1` 灰度开（默认关，argus 保留一周期回退）。bundle 内重签 `Agent Neo Computer Use.app`（`com.agentneo.computeruse`）；对话页人话文案+真实 app 图标由 `cuaNarration` 反查 AX 树；默认 `capture_mode=ax`（Accessibility 必需、录屏可选） | `src/host/mcp/mcpDefaultServers.ts`、`src/host/mcp/mcpToolRegistry.ts`、`src/host/tools/vision/cuaNarration.ts`、`src/renderer/utils/computerUseWorkbench.ts`、`scripts/fetch-cua-driver.sh`、`docs/proposals/computer-use-cua-migration.md` |
| CLI config 单源 | `CLIConfigService` 与 `ConfigService` 统一为同一份 config source，避免 CLI 模式与 Tauri 模式读到不同默认值 | `src/cli/config.ts`、`src/host/config/*`（PR #88） |

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
| 稳定性护栏 | 恢复 session 不再卡"就绪"（sessionPresentation 修复）；Write tool row 文件名可点击 + Reveal | `src/host/session/sessionPresentation.ts` |

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
| Main IPC | `src/host/ipc/workspace.ipc.ts` | handleSetCurrent 广播 WORKSPACE_CURRENT_CHANGED |
| Main auth | `src/web/middleware/auth.ts` `src/web/webServer.ts` | `.dev-token` 复用 + shutdown 不清 |
| Tauri | `src-tauri/tauri.conf.json` `src-tauri/src/host.rs` | window.url = about:blank + setup navigate(Url) |
| UI 入口（历史） | `src/renderer/components/features/chat/ChatInput/AbilityMenu.tsx` | 2026-04-24 首次承载 Live Preview URL input + Open 按钮；2026-04-26 B+ 后当前未挂载在 ChatInput，Routing 在 `InlineWorkbenchBar` / Settings “对话”tab，Live Preview 在 `SessionActionsMenu` |
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
| Workbench B+ 信息架构 | 低频动作收进 `+`；Code/Plan/Ask 收进 `+` 菜单；模型和 effort 合并成单胶囊；Routing 由 `InlineWorkbenchBar` 和 Settings “对话”tab 承载；Live Preview 在 `SessionActionsMenu`；Settings 分组导航与页面骨架落地；TitleBar 只保留核心入口，全局工具移入 Sidebar User Menu | `ChatInput/InputAddMenu.tsx`、`InlineWorkbenchBar.tsx`、`ConversationSettings.tsx`、`SettingsModal.tsx`、`SettingsLayout.tsx`、`settingsTabs.ts`、`SessionActionsMenu.tsx`、`Sidebar.tsx`、`WorkbenchTabs.tsx` |
| Live Preview V2-A/B | `devServerManager` 能探测并启动本地 dev server，DevServerLauncher 作为模态入口；bridge protocol 升级到 0.3.0，选中元素带 `className` 与 `computedStyle`；TweakPanel 支持 spacing/color/fontSize/radius/align 5 类 Tailwind 原子改写；V2-C Next.js App Router 支持按 ADR-012 延期 | `devServerManager.ts`、`LivePreviewFrame.tsx`、`TweakPanel.tsx`、`tweakWriter.ts`、`tailwindCategories.ts` |
| Browser / Computer Workbench | in-app managed browser 已从 smoke 级推进到生产化基线：BrowserSession/Profile/AccountState/Artifact/Lease/Proxy、TargetRef/stale recovery、download/upload、fixture-only recipe benchmark 全部有 acceptance；Computer Surface 增加 background AX 与 background CGEvent 两条受控验证路径；2026-06-26 起 Browser/Computer proof 持久化为 `EvidenceRef` 时间线并带 Neo virtual pointer；**ADR-041** 增加本机 Chromium profile Cookie 导入、Chrome Relay 扩展附着、`browser_action.engine` auto/managed/relay 与 dual-engine proof finalizer | `browserService.ts`、`browserProvider.ts`、`browserAction.ts`、`browserActionFinalize.ts`、`browserRelayService.ts`、`relayActionFacade.ts`、`browserProfileImportService.ts`、`computerUse.ts`、`desktop.ts`、`browserComputerProofStore.ts`、`BrowserSurfacePanel.tsx`、`resources/browser-relay-extension/*`、`docs/architecture/decisions/ADR-041-browser-login-reuse-parity.md`、`docs/acceptance/browser-login-reuse-parity.md` |
| Activity Providers | OpenChronicle 与 Tauri Native Desktop 不再各自直塞 prompt；新增 provider-neutral `ActivityContextProvider`、`ActivityProvider` contract、prompt formatter 与 renderer preview。OpenChronicle 仍是外部 daemon provider，Tauri Native Desktop 是 bundled provider | `activityContextProvider.ts`、`activityProviderRegistry.ts`、`activityPromptFormatter.ts`、`activityContext.ts`、`activityProvider.ts` |
| Semantic Tool UI | 工具 input schema 强制注入 `_meta.shortDescription`；provider parser 抽出 `_meta` 写到 ToolCall 顶层并剥离执行参数；SessionRepository 对无 `_meta` 的历史/弱模型工具调用生成 fallback shortDescription。前端用语义标题、target icon、memory citation 折叠卡、会话 diff 聚合卡和 URL favicon chip 改善可读性 | `prompts/builder.ts`、`model/providers/shared.ts`、`SessionRepository.ts`、`ToolHeader.tsx`、`MemoryCitationGroup.tsx`、`SessionDiffSummary.tsx`、`LinkPreviewCard.tsx` |
| Eval / model 协议修复 | 评测实验支持 SSE 进度、行点击进详情、fatal inference error 熔断、DB 去重；multi-turn adapter 真保留 messages；recent memory 在评测中隔离；thinking-mode provider 补齐 `reasoning_content` history 字段；`max_tool_calls` 从 critical gate 降为 weighted score | `testRunner.ts`、`agentAdapter.ts`、`retryStrategy.ts`、`providers/shared.ts`、`docs/knowledge/eval-tracking.md`、`docs/knowledge/bug-fixes.md` |

#### Live Preview V2 当前边界

V2 的稳定口径是 **Vite-only MVP**：自动起 dev server + 点击源码定位 + TweakPanel 原子样式修改。Next.js App Router 不计入 V2 完成定义，原因见 ADR-012。后续若 React / Next / SWC 生态出现可复用方案，再重新评估 V3。

#### Browser / Computer 当前边界

**2026-07-21 起（ADR-046 / #529 / v0.28.0）**：Browser 与 Computer 收口到 Surface Execution V1 owner-aware 执行运行时（owner 三元组 Session/Grant/Observation、可中止操作队列、Relay 协议 v2 + tab lease、会话执行体验单一投影），详见 `docs/architecture/surface-execution.md`。Browser 主路径仍是 in-app managed browser，默认验收走 System Chrome headless + CDP。**登录态复用**（ADR-041）已交付两条产品通道：（1）本机 Chromium 系 profile Cookie 导入进 managed persistent profile（显式确认 + Keychain，不挂载用户日常 `user-data-dir`）；（2）Chrome Relay 扩展附着真实标签 + `browser_action.engine=relay`，结果走 dual-engine proof/pointer finalizer。远程浏览器池、Firefox/Safari profile 导入、完整 localStorage/IDB 镜像、任意外部 CDP attach 仍属 backlog。Computer Surface 的 background AX / CGEvent 只对显式 target app/window 和本地受控 smoke 成立，foreground fallback 仍是需要人工确认的当前前台动作面。Agent Pointer 是 app surface 内的可视化反馈，不声明系统鼠标所有权；登录、MFA、CAPTCHA、支付和账号安全路径仍走 manual takeover / unsupported 分流。

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
| App (Tauri) | 主力体验，完整本地能力 | `src-tauri/` + `src/host/platform/` |
| CLI | 极客/Agent 调用/MCP Server | `src/cli/index.ts`（[详细架构](./architecture/cli.md)）|

### 平台抽象层 (`src/host/platform/`)

v0.16.44+ 引入平台抽象层，统一封装 Tauri/Electron/Web 的差异 API（窗口管理、路径、剪贴板、Shell、通知、全局快捷键、IPC 注册），业务代码不再直接导入 Electron 或 `@tauri-apps/*`。

关键技术决策：
- **Tauri 2.x 替代 Electron**：DMG 从 742MB → 33MB（95% 缩减）
- **Rust shell 启动 Node.js webServer 子进程**，health check 检测开发模式
- **CSP 安全策略 + capabilities 权限模型**

---

## 2026-06-08 新增模块 — 经验沉淀重做 + Telemetry 可诊断性 + 卸载/权限三层修复

> 一次 dogfood 暴露三条问题串成本批主线：① 跑 3 次 bash 被提议存成 `bash-bash-bash-bash` skill；② 全权限模式下"卸载 app"反复说"等你确认"却不动手；③ 出问题无法脱离用户机器复现一条完整轨迹。完整产品合同见 **2026-06-08 spec**，决策升格见 **ADR-020**，设计稿见 经验沉淀重做+卸载修复、Telemetry 可诊断性方案。

| 主线 | 当前闭环 | 关键文件 / 入口 | 落点文档 |
|------|---------|----------------|----------|
| 经验沉淀重做（ADR-020） | **物理移除** telemetry n-gram 频次蒸馏路（`extractSuccessPatterns`/`suggestSkillName`，-147 行）；skill 沉淀统一收口 `conversationReview` LLM 反思路并升级 Hermes/Anthropic 规格：入口闸（任务完成+非平凡，≥2 种语义不同工具或多步数据流依赖）→ 反思门（抽不出可陈述意图则沉默，取代"≥3 次就提议"）→ 命名禁用清单（`isLowValueSkillName` 拦泛词/工具名拼接，解析+入队两处）→ 结构化 SKILL.md（复用 ADR-002）。failure journal 链路保留 | `lightMemory/conversationReview.ts`、`agent/runtime/learningPipeline.ts`、`services/skills/skillDraftQueue.ts`、`shared/constants/memory.ts` | [agent-core.md](./architecture/agent-core.md) |
| 卸载/权限三层修复 | ① safety.ts 改措辞：删除/卸载**直接调工具**，确认交权限卡片，禁止光说不做；② commandSafety rm 分级：目标明确单路径删除从 `critical 硬毙` 降为 `high→prompt 一次确认`，灾难性（`rm -rf /`/`~`/`/*`/通配删根家）仍硬毙；③ agentOrchestrator 挂起权限死锁——新消息/取消时 resolve 挂起请求，不再冻结到 60s 超时 | `prompts/constitution/safety.ts`、`security/commandSafety.ts`、`agent/agentOrchestrator.ts` | [agent-core.md](./architecture/agent-core.md)、[tool-system.md](./architecture/tool-system.md) |
| Telemetry 可诊断性 P1（版本指纹） | 每条 trace/session 带 `agentVersion`(app version,自动) + `promptVersion`(`PROMPT_VERSION` 常量,改 prompt 静态模块手动 bump) + `toolSchemaVersion`(protocol registry schema SHA-256 前 12 位,自动)，进 Langfuse metadata + 本地 SQLite session 表。放弃原 build 期 registry（运行时 prompt 动态拼装 hash 匹配不上）；精确复现仍靠 turn 级 `systemPromptHash`+`system_prompt_cache` | `telemetry/diagnosticVersions.ts`(新增)、`shared/constants/agent.ts`、`shared/contract/telemetry.ts`、`services/core/database/{schema,migrations}.ts`、`telemetry/{telemetryCollector,telemetryStorage}.ts`、`services/infra/langfuseService.ts`、`agent/runtime/conversationRuntime.ts` | [data-storage.md](./architecture/data-storage.md) |
| Telemetry 可诊断性 P3（默认开） | Langfuse 默认启用（复用 `getServiceApiKey` 既有 `LANGFUSE_*_KEY` env fallback，无需新写注入）：`initBackgroundServices` 从"只看 key 在不在"改为"`enabled===false` 才跳过、否则 key 可用即 init"；隐私设置页加 telemetry opt-out 开关（默认开，浅合并保 key）。⚠️ 默认链路当前含内容，**推广前须收敛 metadata-only + 补首启同意**（发布 gate） | `app/initBackgroundServices.ts`、`renderer/.../settings/tabs/PrivacySettings.tsx` | [data-storage.md](./architecture/data-storage.md) |
| Telemetry 可诊断性 P2（本地全量 + 触发上报） | 本地 `telemetry_raw_payloads` 旁表存全量 prompt/completion/工具入出参，三重封顶滚动淘汰（turn/天/库体积，单条超阈截断记原长）；`buildDiagnosticBundle` 组装自包含诊断包（版本+环境指纹+span 树+内容），`sanitizeDiagnosticBundle` 跑密钥/token/PII 脱敏后入 `telemetry_diagnostic_bundles` 排队表；命中失败信号上报。**本地原文不动，只脱敏上传副本**。⚠️ dogfood 期静默自动上传，**推广前须改回知情同意 + 内联轻提示**（发布 gate）。随 telemetry 分支 merge `cd0ffb9d3` 进 main | `telemetry/diagnosticBundleService.ts`(新增)、`telemetry/{telemetryStorage,telemetryCollector,telemetryUploaderService}.ts`、`security/logMasker.ts`（超大输入预截断修 ~110s 卡顿） | [data-storage.md](./architecture/data-storage.md) |
| 06-07 下午稳定性收尾 | harden provider selection+diagnostics；云端同步会话改幂等 upsert（修 NULL-owner 主键冲突刷屏）；sseStream 响应头首字节超时（修 accept-then-hang）；截图发非视觉模型不再丢图（改用配置识图模型）；skill 名称容错+did-you-mean；删 mailboxBridge+10 未用依赖；抽 `trackFileMutationSideEffects`/`handleToolExecutionError` 收敛 executeSingleTool | `model/adapters/aiSdkAdapter.ts`、`model/providerConnectionTest.ts`、`agent/runtime/{toolArgsValidator,toolExecutionEngine}.ts`、vision/session 同步路径 | [agent-core.md](./architecture/agent-core.md) |

**架构边界澄清**：
- 经验沉淀不再保留 n-gram 召回（不做"加语义过滤保双路"折中）；信号从"工具调用频次"切换到"可泛化+有意图+经验证+可压缩"，与 Hermes/Voyager/Anthropic Agent Skills 标杆一致。召回从此单点依赖 quick model 复盘质量，模型不可用时静默降级不沉淀。
- 不改全权限默认值（`bypassPermissions.dangerous` 维持 `'prompt'`）；危险操作保留**一次**确认，本批只让这次确认真正能走通，不放开无确认删除。
- Telemetry P1+P2+P3 全部落地。版本指纹（P1）与 Langfuse 默认开（P3）在 fix 分支与 telemetry 分支各独立提交一次，合并以 telemetry 分支为准（更全实现）；P2 诊断包整链路随 telemetry 分支 merge 进 main。两条 gate 仍悬：默认链路含内容须收敛 metadata-only、P2 静默上传须改回知情同意。
- Supabase `telemetry_sessions` 上传 payload 暂不加版本列（防 `column does not exist` 把上传搞挂），待后台加列后再补 `toSessionRow`。

---

## 2026-06-06 ~ 06-07 新增模块 — 反循环防御三层补全 + 发行/更新基建 + 配置热重载

> 承接 06-05 对话式自动化批次（已记入 v9.18 + 2026-06-05 spec）。本批两条主线：① 把"弱模型反复调工具不收敛"这类失败模式的防御补全成稳定的三层结构；② 发行/更新/配置侧的工程基建（renderer 热更新灰度、in-app updater ACL、运行权限 auth、config 热重载）。

### 反循环防御三层（本批补全后定型）

多模型路由下不能假设模型会自终止（强模型几乎不触发，弱模型如 mimo-v2.5-pro 会反复调同类工具不收尾，run 被中断后 0 条 assistant 落库 → 侧栏空白"待处理"）。现有三层互补、各管一类失败：

| 层 | 触发条件 | 处置 | 关键文件 | 本批变更 |
|----|---------|------|---------|---------|
| L1 熔断器 | 连续**工具失败** ≥5 次 | 跳闸 → 注入 `<circuit-breaker-tripped>` 让模型停手报错 | `agent/toolExecution/circuitBreaker.ts` | 旧有，未改 |
| L2 只读循环熔断 | 连续**只读操作** ≥5 警告 / ≥15 HARD_LIMIT | 警告软提示；硬阈值 preflight 拦截并 `activateForceFinalResponse`，把"基于已有证据作答"回灌逼模型收尾 | `agent/antiPattern/detector.ts`、`agent/loopTypes.ts`（`READ_ONLY_TOOLS`） | **补全**：`READ_ONLY_TOOLS` 之前只有 `web_fetch`，漏了 `WebSearch`/`WebFetch`/`web_search`（模型实发 PascalCase），导致搜索循环完全不计数；本批补齐，搜索循环纳入 5 警告 / 15 硬停 |
| L3 语义重搜检测 | 同一**检索类工具**（WebSearch/WebFetch/ToolSearch）在 6 次窗口内 ≥4 次 | 注入一次软提示，引导用现有结果作答或如实说明限制 | `agent/runtime/stagnationDetector.ts`（`pushAndDetectToolSpam`）、`messageProcessor.ts`、`runtimeContext.ts` | **新增**：原 fingerprint 只抓 name+args+result 完全相同的死循环，抓不住"换关键词重搜同一意图"（args 变→fingerprint 变）；L3 按工具名计数补这个盲区 |

**边界澄清**：
- L2 计连续**只读 op 数**（含 read_file/grep/glob/网络读），写工具/Bash/`markSemanticProgress` 清零；L3 只计**检索类工具的语义重复**，两者正交——L2 防"读不停"，L3 防"换词重搜"。
- L2 的 `HARD_LIMIT` 是真护栏（preflight 阻断 + 强制收尾产出答复，不再空白）；L3 是软提示（命中只提示一次，不 break），优先让模型自己收。
- 任何**无界只读工具**（联网搜索/抓取、未来的外部查询类工具）新增时必须同步登记进 `READ_ONLY_TOOLS`，且 PascalCase + snake_case 别名都加。详见 troubleshooting.md「普通对话里反复 WebSearch 不收敛」。

### 发行 / 更新 / 配置基建（06-06 收口）

| 主线 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Renderer 热更新 + 灰度 | renderer bundle 独立构建签发，经 control-plane 分阶段灰度发布；附冒烟 + manifest diff 验证流水线；manifest diff 容忍过期 base，不阻断重新签发 | `scripts/build-renderer-bundle.mjs`、`scripts/control-plane-release-bundle.mjs`、`scripts/control-plane-smoke.mjs`、`scripts/renderer-manifest-diff.mjs`、`scripts/acceptance/renderer-hot-update-smoke.ts` |
| In-app updater ACL 修复 | 修复 in-app 更新被 Tauri capabilities ACL 拦死；更新体验打磨 + 稳定版 release JSON / manifest 生成脚本 | `src-tauri/capabilities/default.json`、`scripts/tauri-update-manifest.mjs`、`scripts/build-stable-release-json.mjs`、`scripts/lib/release-notes.mjs` |
| 运行权限模式 auth | 补齐运行权限模式后端 + 管理员状态广播接线（收尾 auth 线） | `src/host/ipc/agent.ipc.ts`、`src/host/services/infra/supabaseService.ts`、`src/web/webServer.ts` |
| config.json 热重载 | config.json 外部编辑即时生效，无需重启（带 reload 单测） | `src/host/services/core/configService.ts`、`src/host/app/initBackgroundServices.ts` |
| GUI slash 命令走 IPC/store | GUI slash 命令统一走 IPC/store 路径 + 修键盘 Enter 提交竞态；冷启动/切会话不再闪现默认页 | `renderer/.../chat/ChatInput/SlashCommandPopover.tsx`、`src/shared/ipc/domains.ts`、`renderer/components/ChatView.tsx` |

---

## 2026-06-03 ~ 06-04 新增模块 — 多 Agent 协作层 + 项目空间 + 角色产品化

> 承接 auto-mode/settings 批次，把 Neo 从"会话级编程助手"推进到"项目级人机协作产品"。完整产品合同见 **多 Agent 协作 + 项目空间 + 角色产品化批次 spec**。各主线另有设计文档：swarm-goal、project-space、role-proactivity、locality-feedback。

| 主线 | 当前闭环 | 关键文件 / 入口 | 落点文档 |
|------|---------|----------------|----------|
| 角色主动性（P0-1 下半） | 角色按 cadence（启动注册 per-role cron）+ 长任务 event（Stop hook，turn≥5）醒来，查自己产物历史，解析 `<decision>advance\|report\|suggest\|silence</decision>`；硬预算 15 turn/次、4 次/天；出厂默认 **silent**（opt-in） | `src/host/services/roleAssets/roleProactivity.ts`、`agent/runtime/runFinalizer.ts`、`shared/constants/memory.ts`（`ROLE_PROACTIVITY`）、`renderer/.../settings/tabs/RolesTab.tsx` | [multiagent-system.md](./architecture/multiagent-system.md) |
| Swarm goal + 主动性合流（P4） | `GoalContract.allowSwarm`（默认 true，advance→goal 强制 false）以 dynamic-workflow scriptRuntime 为编排基底；三层闸只在总体层，子任务校验交脚本 verification；swarm token 经 `ToolResult.metadata.tokensSpent` 回灌 goal 预算（`SWARM_GOAL` 常量） | `agent/goalModeController.ts`、`shared/contract/appService.ts`、`agent/runtime/contextAssembly/deferredToolPreload.ts`、`shared/constants/agent.ts` | [multiagent-system.md](./architecture/multiagent-system.md) |
| Swarm 执行层护栏（P1-2/P1-4） | 结构化失败码 `depth-limit`/`child-refusal`/`child-max-tokens`/`parent-gone`（NON_CASCADE，`routeFailureCode()` 路由 throw/degrade/retry/surface）；spawn 深度截断 `SPAWN_GUARD.MAX_DEPTH=1`/`MAX_AGENTS=6`；SharedContext 版本戳 + `isStale`；Agent Inbox 非破坏 peek；后台 detached 子代理父探活（`isParentRunAlive`）自回收 | `shared/contract/cancellation.ts`、`agent/multiagentTools/spawnAgent.ts`、`agent/orphanLiveness.ts`、`agent/agentInbox.ts`、`agent/parallelAgentCoordinator.ts` | [multiagent-system.md](./architecture/multiagent-system.md) |
| Swarm 协作可见性（P1-3） | `SwarmContextUpdate`（kind = finding/decision/status/result + role + at）经 `swarm:context:update` 事件喂 `DiscussionStream`，收起态显近 3 条、展开全时间线、决策高亮 | `shared/contract/swarm.ts`、`agent/swarmEventPublisher.ts`、`agent/multiagentTools/statusReport.ts`、`renderer/components/features/swarm/DiscussionStream.tsx`、`SwarmInlineMonitor.tsx`、`stores/swarmStore.ts` | [frontend.md](./architecture/frontend.md)、[multiagent-system.md](./architecture/multiagent-system.md) |
| 项目空间容器（P0-2） | `projects` / `project_goals`（多 goal）/ `project_roles` 三表 + `sessions.project_id` 幂等回填；1:1 workspace 绑定 + 隐式归桶（未映射 `proj_unsorted`）；`domain:project` IPC 双路（桌面原生 + HTTP）；`projectGoalToRunInput()` 单向只读投影守 P4 边界；Workspace Preview 升项目维度跨 session 产物聚合 | `services/core/database/schema.ts`、`ProjectRepository.ts`、`services/.../projectService.ts`、`project.ipc.ts`、`renderer/.../ProjectHeaderBar.tsx`、`renderer/utils/workspacePreview.ts` | [ipc-channels.md](./architecture/ipc-channels.md)、[frontend.md](./architecture/frontend.md) |
| 定点反馈（locality-feedback） | 两层分离：Layer A 在 `workbenchTurnContext.ts` 注入 `<live_preview_selection>` 块，模型自路由 `visual_edit`/`ppt_edit`/`excel_edit`；Layer B 网页/PPT/表格各自加点选→反馈入口；Phase 2/3 锚点编码进消息文本，零扩 envelope | `main/app/workbenchTurnContext.ts`、`renderer/.../LivePreview/LivePreviewFrame.tsx`、`DesignPptPreview`、`SpreadsheetBlock` | [frontend.md](./architecture/frontend.md)、[tool-system.md](./architecture/tool-system.md) |
| 能力产品化（P2-1/P2-2） | 内置角色（研究员→`Microscope`、数据分析师→`BarChart3`）+ 17 内置技能一次性回填 icon + `SkillCategory`（复用既有七分类，不造 `SkillBundle`）；自定义无元数据回落默认头像 + "其他"组 | `services/roleAssets/builtinRoles.ts`、`services/skills/builtinSkills.ts`、`renderer/.../RoleIcon.tsx`、`settings/tabs/{RolesTab,SkillsInstalledTab}.tsx` | [frontend.md](./architecture/frontend.md) |
| 只读任务状态 MCP（P3-A） | 三只读工具 `neo_list_tasks`/`neo_get_task_status`/`neo_list_projects`，只出状态枚举/进度计数/token-cost/`filesChangedCount`（计数不出路径）；`includeContent` 默认 false；`TaskStatusProvider` 桥接由 app 启动注册，web 路径与 main 路径双注册幂等（修发行版 web 路径漏启 logBridge） | `main/mcp/taskStatusProvider.ts`、`mcpServer.ts`、`logBridge.ts`、`web/webServer.ts`、`app/initBackgroundServices.ts` | [MCP_SERVER.md](./MCP_SERVER.md)、[tool-system.md](./architecture/tool-system.md) |

**架构边界澄清**：
- swarm goal 复用 dynamic-workflow scriptRuntime，不引入新并行运行时；三层闸只在总体层，不做子级 DAG / 子级闸（P4.2+ 再做）。
- spawn 护栏延续取消级联契约：失败码区分 CASCADE / NON_CASCADE，子代理失败/超时只熔断自身；孤儿回收是结构化并发探活，非 heartbeat。
- 角色主动性 P0-1 只走 session 消息 + history append + （realtime）Electron Notification，不接外部渠道；范围只查角色自己参与的产物（P0-2 后升项目维度）。
- project-space 零改 `GoalContract` / `GoalRunInput`，只用 `projectGoalToRunInput()` 只读投影；1:N project↔workspace 留后续。
- locality-feedback Phase 2/3 不扩 `ConversationEnvelope` 字段，锚点进消息文本前缀，保持 envelope 合同稳定。
- P3-A 只读，不暴露 prompt / 输出正文 / 文件路径 / goal 指令 / 项目描述；它是结构化元数据外露给外部编排器（Coze / codeg 等），守"本地隐私"卖点。

---

## 2026-06-02 新增模块 — 极客时间课程差距修复（四阶段）

> 对照极客时间《Agent 设计模式之美》等课程逐条审计出 23 条 findings，按"假护栏 → 上下文经济 → 质量闭环 → 经验沉淀"四阶段修复 17 条。阶段一/二/三经 PR #192 / #194 / #196 合并，阶段四在 `feat/geektime-gap-phase4-experience`。完整产品合同见 **极客时间差距修复 spec**。

| 阶段 | 主题 | 核心交付 | 落点文档 |
|------|------|----------|----------|
| 一（PR #192） | 拆假护栏 | skill allowed-tools 限权边界、PolicyEnforcer 接线、配置 typo 告警、AI SDK 路径 prompt caching 恢复 | [tool-system.md](./architecture/tool-system.md)、model-config.md |
| 二（PR #194） | 上下文经济 | MCP 工具名索引（deferred 化）、大工具结果落盘可回查、git 分支/commit/dirty 注入 env block | [tool-system.md](./architecture/tool-system.md)、[agent-core.md](./architecture/agent-core.md) |
| 三（PR #196） | 质量闭环 | Stop hook 完成闸 + PostToolUse 自修复、workflow 反死循环 + stage outputSchema、交付前 critic、prompt 预算动态化 + 块优先级 + 丢弃可见化、SubagentStop trace + hook 日志脱敏 | [agent-core.md](./architecture/agent-core.md)、[dynamic-workflow.md](./architecture/dynamic-workflow.md)、[multiagent-system.md](./architecture/multiagent-system.md) |
| 四（本分支） | 经验沉淀 | learningPipeline 重建（failure journal 全自动 + skill 蒸馏半自动确认制）、子代理 skills 全文预注入（方向 A）、评测中心 harness 对照实验 | [agent-core.md](./architecture/agent-core.md)、[multiagent-system.md](./architecture/multiagent-system.md)、评测系统指南、[ipc-channels.md](./architecture/ipc-channels.md) |

经验沉淀（阶段四）是 cowork 产品的核心差异化："Neo 处理过 100 个任务后，对这个仓库的了解不再和第 1 个任务时一样"——失败的坑跨会话避开，成功的工作流半自动固化为 skill。

---

## 2026-05-29 ~ 06-01 新增模块 — Dynamic Workflow + Runtime Consolidation + Product Closure

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

`admin-console/` 扩展：新增 errors / feedback 页、session 详情页、Sentry 接入（`lib/sentry.ts` + `src/host/observability/sentryNode.ts`）、PostHog dashboards 与 live-event smoke 脚本。详见 [observability.md](./architecture/observability.md) 与 `docs/plans/2026-05-28-fleet-observability-plan.md`。配套 `feat: improve cowork orchestration UX`——声明式 `workflow_orchestrate` 的 telemetry / 编排体验增强（与命令式 M1 不同路径）。

### M5: Runtime Consolidation / Architecture Debt

5/31 晚到 6/1 早上的收口把运行时边界从“大文件互相知道”拆成端口和策略层：`runtimePorts` / `runtimeControl` / `subagentExecutorPort` 收窄 agent runtime 依赖，`modelRouterPolicy` / provider HTTP/JSON/parser helpers 拆开模型路由热路径，`agentRunController` / `agentRunEventCollector` / `devSeedHelpers` 拆开 app-host routes。配套删掉 dead worker、teamManager、legacy file/shell wrappers、old research helpers、cloudStorageService 和一批旧 renderer 面板。

架构快照见 [runtime-consolidation-2026-05-31.md](./architecture/runtime-consolidation-2026-05-31.md)，分阶段债务计划见 [agent-architecture-debt-iteration-plan-2026-05-31.md](./architecture/agent-architecture-debt-iteration-plan-2026-05-31.md)。

### M6: Agent Neo Product Closure / Long Task Quality Loop

产品闭环把长任务默认路径、安全自治和质量 gate 收到一条线上：普通任务留在 Chat，复杂长任务默认 `/workflow`，Agent Team 是 expert audit 路径，`spawn_agent` / `workflow_orchestrate` 是 compatibility path。`DecisionTrace` 和 `WriteIsolationManager` 让自动权限和写冲突可回放；`background` app-host route 支持 pause/resume/background/foreground；生成物质量进入 `ArtifactIssue`、`EvalReplayQualityReport` 和 Admin Review Queue。

规格见 2026-05-31-agent-neo-product-closure.md，质量数据面见 [artifact-verification.md](./architecture/artifact-verification.md)。

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

> 设计文档 ws4-memory-consolidation.md，as-built 与设计零偏差。

### W3: MCP 只读安全边界（WS5）

Neo 作为 MCP server 对外暴露能力时，**控屏/写入类能力永不通过 MCP 暴露**（与上文 2026-05-13 "Computer-use MCP 入口归位"区分：那是 Neo 把 Computer 包成 native ToolModule 给**自己**用；WS5 是 Neo **对外**作为 MCP server）。

| 阶段 | 做什么 | 落点 |
|------|--------|------|
| **WS5a 止血** | 给 `computer`/`execute_command`/`clear_logs` 加 opt-in 闸 + env flag（默认关），新增 `eval-query`/`appshots-query` 只读工具 | `src/host/mcp/mcpServer.ts`（commit `e281196c`） |
| **WS5b 定调** | 评估后**否决**门控方案——stdio MCP 无法可信认证 caller（无 mTLS/OAuth），5 层授权门复杂度失衡 → **彻底移除**三个控屏工具及全部 gate 代码 | `mcpServer.ts` 从 ~229 行收敛为只读不变量（commit `8c85ac22`） |

当前 MCP server 仅暴露 5 个只读工具：`get_logs` / `get_status` / `screenshot`（读屏不控屏）/ `eval-query` / `appshots-query`。强制方式 = 直接不定义 control 工具，调未定义工具返回 `Unknown tool`。正确的控屏路径是 **Neo 作为 orchestrator 编排外部 agent**，不是外部反向控制 Neo。详见 [MCP_SERVER.md 安全边界](./MCP_SERVER.md) + ws5b 决策。

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
| **AiSdkModelAdapter** | `src/host/model/adapters/aiSdkAdapter.ts` | 实现现有 `ModelRouter.inference` 契约。`generateText`（非流式，服务子代理 + artifact 重试）+ `streamText`（流式，主 loop，`fullStream` 映射成项目 StreamChunk 契约）；`tool()` 只取 schema，执行仍走 Neo 自己的 toolExecutor + 权限/审计/hook |
| **引擎开关** | `CODE_AGENT_MODEL_ENGINE` flag | 子代理 + 主 loop 默认 aisdk（`!== 'legacy'`），`=legacy` 一键全回退旧 modelRouter；`AISDK_UNSUPPORTED_PROVIDERS` 已清空（2026-05-27 收口），**所有 provider 都走 AI SDK，不再有自动降级**，该集合留待 P3 净删旧路径时一并删除 |
| **provider 路由** | `aiSdkAdapter.resolveModel()` + `providerResolution.ts` | 按 provider 选包：deepseek→`@ai-sdk/deepseek`、anthropic→`@ai-sdk/anthropic`、gemini→`@ai-sdk/google`、openrouter→`@openrouter/ai-sdk-provider`、其余（zhipu/moonshot/xiaomi/longcat/qwen/…）→`@ai-sdk/openai-compatible` + `buildVendorCompatSettings()`（thinking 字段/采样参数）。baseURL/apiKey 仍由 `providerResolution.ts` 收口（zhipu 三态 / moonshot 专端点 / `resolveProviderApiKey(trustConfigKey)` 区分主 loop vs 子代理）；zhipu 免费档并发 limiter 套在 `inferenceViaAiSdk()` 外层 |
| **消息归一** | `aiSdkAdapter.toAiMessages` + `reorderToolResultsAfterAssistant` | Neo ModelMessage ↔ AI SDK ModelMessage；镜像旧路径 `sanitizeToolCallOrder` 把夹在 assistant tool-call 与 tool-result 之间的 system 消息后移（否则 AI SDK 校验抛 `MissingToolResultsError`） |
| **瞬态重试** | `withTransientRetry` + `emittedOutput` 闸门 | adapter `maxRetries:0` 交项目统一策略（网络 + HTTP 瞬态都覆盖）；流式仅"首个可见 delta 之前"的瞬态失败才重试，已吐字后绝不重试 |

> 收口效果：从根上消灭"流式/非流式两套解析不对称"的整类 bug（DeepSeek 非流式把 tool call 吐成 `<｜｜DSML｜｜>` 文本漏调用等）；新接模型不再要写一批 per-model 解析分支 + 隐藏 bug。
>
> **全量收口（2026-05-27，WS1 Phase 1-2，commit `8479276d` / `85bc4ac2`）**：gemini+openrouter 迁官方包（`@ai-sdk/google` / `@openrouter/ai-sdk-provider`）、zhipu/moonshot/xiaomi 迁 `@ai-sdk/openai-compatible`，`AISDK_UNSUPPORTED_PROVIDERS` 清空——全 provider 走 AI SDK。旧手写层（`BaseOpenAIProvider`/`openaiWrapper`/`sseStream`）仅 legacy 引擎保留，待 P3 净删。详见 [migration §7](./architecture/ai-sdk-provider-migration.md)。

### M2: Goal Mode — `/goal` 自治目标循环（三层闸）

详见 /goal 模式设计。核心论点：完成判定权从 prompt 层提升到**代码层**，模型调 `attempt_completion` 只是"申请退出"，绕不过闸。

| 模块 | 位置 | 描述 |
|------|------|------|
| **闸编排** | `src/host/agent/goalModeController.ts` | GoalContract / buildGoalContract（verify 与 review 二选一）/ 闸3 evaluateFallback（token budget · max-turns · 连续无进展）/ continuation + Codex 式 audit nudge / recordTurnProgress |
| **闸1（硬·确定性）** | `src/host/agent/goalVerifyGate.ts` | `runVerifyGate()` 直接 `/bin/sh -c` exec `--verify` 命令 parse 退出码——**不经 LLM**，绕开"对话不可信" |
| **闸2（软·可选）** | `src/host/agent/goalReviewGate.ts` | `runReviewGate()` 派 `goal-review` 子代理（`powerful` tier，带 read/grep/glob/ls），parse 末行 `VERDICT: PASS\|FAIL` |
| **完成申请** | `attempt_completion` 工具 + `messageProcessor` 拦截 | goal-mode 才预加载暴露；调用即触发三层闸，模型无法自称完成直接退出 |
| **循环改造** | `src/host/agent/runtime/conversationRuntime.ts` | text-stop `break` → goal-mode `continue`（注续跑提示/审计 nudge）；loop-top 每轮跑闸3 |
| **SSE + UI** | `src/shared/contract/agent.ts` + renderer | `goal_iteration` / `goal_gate` / `goal_complete{status}`；`/goal` 斜杠命令 + `GoalStatusBar` 实时状态条 + `GoalNoticeMessage` 生命周期卡片；桌面 IPC + headless REST 双链路 |

### M3: Appshots — 窗口快照 → 多模态上下文（macOS）

详见 Appshots 设计。Phase 1-4 全部已并 main（含 Phase 3.1 多屏 / 4a 设置 UI / 4b OCR 预编译二进制）。

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
| **沙箱实现** | `src/host/sandbox/{seatbelt,bubblewrap,manager}.ts` | macOS `sandbox-exec` + `generateProfile()` / Linux `bwrap` / 统一 `SandboxManager`（原为零调用死代码，本轮接线） |
| **命令包装接线** | `src/host/tools/modules/shell/bash.ts` + `wrapCommand` API | 仅 `bypassPermissions` 档：把命令前缀包装成 `sandbox-exec -f <profile> /bin/sh -c "<cmd>"` 喂回原 `runForegroundCommand`（流式/中断/错误语义白嫖，不用缓冲式 `executeInSandbox`） |
| **fail-fast** | bash.ts 模式判定 | 沙箱不可用 → 硬报错 `SANDBOX_UNAVAILABLE` 拒绝执行，**绝不静默裸跑降级** |
| **门控** | `SANDBOX.OS_SANDBOX_ENABLED`（constants.ts） | 默认关 + env 启用（沿用 `CODEX_SANDBOX` 惯例）；profile=allow-default + 锁写、subpath 须 realpath |

> 顺带：node-pty `spawn-helper` 执行位经 `postinstall` 恢复（资源扫描 EACCES / PTY 起不来）。

### M5: 附件管线 v2 — 多类型附件 → 端侧摘要 → 模型上下文（迭代追加，🚧 wip）

详见 附件管线 v2 设计。本轮 commit `162f54f5` 在 v0.16.80 之后追加（来自验收迭代，**未经逐行 review，待后续处理**）。核心思路：**重二进制在端侧提炼成轻量摘要，本体既不喂模型也不写库**。

| 模块 | 位置 | 描述 |
|------|------|------|
| **契约扩类** | `src/shared/contract/message.ts` | `category` 补 `audio`/`video`/`presentation`/`archive`（`document` 收窄为 DOCX）；新增 `PresentationSummary` / `ArchiveManifest` 类型 + 附件字段 `pptJson` / `archiveManifest` |
| **端侧摘要** | `src/renderer/.../ChatInput/attachmentSummaries.ts` | 上传时 `jszip` 解 PPTX 逐页取文字/图/表（≤20 页）、解 ZIP 出目录清单（≤200 条 + zip-slip 危险路径检测）；**不自动解压**，仅产摘要 |
| **模型序列化** | `src/host/agent/messageHandling/converter.ts` | `buildMultimodalContent` 新增 audio/video/presentation/archive 分支：渲染元数据/摘要 + 工具引导（PPT 引导走 `ppt_edit analyze`）；`canProcessAttachmentWithoutData` 准入闸 |
| **strip + 瘦身** | `src/shared/utils/messageAttachments.ts` | `stripInlineAttachmentBlocks`（`<attachment>` 对用户隐藏、对模型可见，镜像 Appshots）；`sanitizeAttachmentsForPersistence`（入库前剥离非图片大 data URL，只留摘要） |
| **持久化接线** | `SessionRepository.ts` / `web/{routes/agent,helpers/sessionCache}.ts` | desktop + web 双链路统一在持久化边界 strip content + sanitize attachments，行为对齐 |

---

## v0.16.76-79 新增模块 — 插件化 / 能力路由 / 死代码瘦身 / 依赖大版本（2026-05-19 ~ 05-21）

接 v0.16.75 的 Agent Neo 管理面，本轮三天 50 commits 集中在：把多模态/桌面能力剥成 builtin plugin（PluginAPI v2）、Marvis 风格的能力路由、删 evaluation 子系统死代码、quick model 路径修复、工具失败输出对模型可见、依赖统一升大版本、release 签名/公证管线收口。

### M1: 插件化重构 — PluginAPI v2 + 7 个 builtin plugins

详见 [插件系统架构](./architecture/plugin-system.md) 与 ADR-017。

| 模块 | 位置 | 描述 |
|------|------|------|
| **PluginAPI v2** | `src/host/plugins/types.ts`、`pluginRegistry.ts` | `pluginApiVersion: 2`；新增 `getApiKey`（15 provider 白名单 ReadonlySet runtime 校验）/ `getCurrentUser`（`{id,isAdmin}` + admin trust-gate）/ `getConstants`（models·providers·pricing·timeouts 4 桶双层 freeze，过滤内部代理 URL）/ `registerToolModule`（ToolModule 协议 + emit + artifact） |
| **Builtin Loader** | `pluginRegistry.loadBuiltinPlugins()` | `initialize()` 静态 import 7 个 builtin manifest+entry，esbuild tree-shake 到 host 同 bundle；第三方磁盘加载链路（discover/load/watch）原样保留 |
| **7 个 builtin plugins** | `src/host/plugins/builtin/*` | imageProcess / audioProcessing / videoGeneration / imageCreation / browserControl / computerUse / photoArchive 从 `tools/modules/` 剥离；builtin 用 `prefixWithPluginId: false` 保留原工具名，executionPhase / deferredTools / prompt / cache / eval baseline 零改动 |
| **Plugin 化边界 (ADR-017)** | [plugin-system.md](./architecture/plugin-system.md) | 11 个难剥 service 按性质分三层 RED：Prompt Context Contributors（9 个，注入 system prompt）/ Runtime Planning State（plan/task 控制状态，留 core）/ Assembly Policy（context pressure + token 预算，留 core），防"按不能 plugin 化命名的层"沦为垃圾桶 |
| **desktop facade 收口** | `src/host/desktop/desktopContextBridge.ts` | `bootstrapDesktopTurnContext` 高层入口聚合 desktop turn 状态同步（todo/task/planning/workspace/recovery）；`conversationRuntime` 删 3 处 desktop 直接 import，`bootstrapDesktopDerivedContext` ~165→~70 行，只留 Assembly Policy 层 |
| **管理员插件管理** | renderer settings + extension 路由 | admin plugin management settings 暴露；plugin slash command 走 extension 路由；verified auth 后保留 admin profile |

### M2: Marvis 风格能力路由 + Capability Center 增强

| 模块 | 位置 | 描述 |
|------|------|------|
| **Routing assessments** | `src/host/services/capabilities/capabilityAssessment.ts` | Marvis 启发的能力对照/路由评估（接 f2845554 的能力对照补齐） |
| **Chat capability triggers** | `CapabilitySuggestionStrip.tsx`、`CapabilityRecommender.ts`、`sessionSkillService.ts` | 聊天输入区按上下文浮出能力建议条；`/tools` 命令树扩展（+284 行）；推荐进 SlashCommandPopover / InlineWorkbenchBar |

### M3: 死代码瘦身 — 删 evaluation 子系统（-20K 行）

社区调研：8 个主流 code agent（Aider/Cursor/Cline/Continue/Claude Code/Codex/Devin/Cody）无一把 per-session grader + 失败漏斗 + 实验跟踪做成用户功能；本项目 `evaluations` 表 29 条记录、最后写入停在 2026-03-09，典型 over-engineered dogfood 失败。

| 动作 | 范围 |
|------|------|
| **删 UI** | evalCenter 整套（renderer 43 文件）+ `src/host/evaluation/` 17 文件 + 4 子目录 |
| **删 IPC / 契约** | `evaluation.ipc.ts` + 36 个 `EVALUATION_*` channel + `evaluationFramework` / `previewFeedback` contract；WorkspacePreviewPanel 内嵌的 delivery review + preview feedback |
| **删 DB** | drop `evaluations` / `eval_snapshots` / `review_queue_items` / `review_queue_failure_assets` / `preview_feedback_items` 共 5 表 + 3 索引 |
| **保活路径** | `trajectory/` + `replayService` + `telemetryQueryService` + `transcriptReplayBuilder` + `experimentAdapter` + `sessionEventService`（telemetry IPC / agentOrchestrator / bug-report replay 仍依赖）；DB 保 `experiments` / `experiment_cases` / `session_events` / `telemetry_*` |

### M4: 模型路由 — quick model 修复

| 模块 | 位置 | 描述 |
|------|------|------|
| **Provider 并发限流** | `src/host/model/concurrencyLimiter.ts` | 通用 `ConcurrencyLimiter` + `getProviderLimiter`，`PROVIDER_CONCURRENCY_LIMITS={zhipu:{3,200ms}}`；主模型路径与 quick model 路径共用同一 provider 限流器，quickTask 不再裸 fetch 绕过节流打爆智谱免费档 |
| **quickModel 策略化** | quick model 解析路径 | 优先 `routing.fast` → 无 key 回落 `routing.code` 主模型并对 reasoning 模型注入 `thinking:{type:'disabled'}`（否则思考模型短输出被 reasoning 吃光返回空）→ 兜底 env → null |
| **默认 quick model** | `DEFAULT_MODELS.quick` | `glm-4.7-flash`（27-40s 思考模型，撑不住 3s intent 分类）→ `glm-4-flash`（实测 0.7s，非 thinking）；完整加进注册表/pricing/context-window/features/abbrev |

> 验证：真实 API 12 并发 quickTask 从 2×429 + 10 空 + 178s → 12/12 成功 0×429 3.7s。

### M5: 工具失败输出对模型可见（自纠错修复）

`messageProcessor` 取 `output||error`，不读 `meta.output`。命令失败时输出被塞进 `meta.output`，模型只看到 `exit code N` 看不到真因，被迫用 `2>&1; echo $?` 骗成 exit 0 才能看到错误，表现为对同一命令反复重试（实测某 case 跑 5 次）。

| 入口 | 文件 |
|------|------|
| Bash 前台 / PTY | `src/host/tools/modules/shell/bash.ts` |
| 子 agent task | `src/host/tools/modules/multiagent/task.ts` |
| explore 子 agent | `src/host/tools/modules/planning/explore.ts` |

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
| **精确 Token 计数** | `src/host/context/tokenEstimator.ts` | 从字符比例启发式（误差 10-30%）升级为 BPE 实测（gpt-tokenizer，误差 <1%） |
| **CompressionState** | `src/host/context/compressionState.ts` | 不可变 commit log + snapshot 双持久化，追踪所有压缩操作 |
| **ProjectionEngine** | `src/host/context/projectionEngine.ts` | 纯函数投影：transcript + compressionState → API 视图（transcript 永不修改） |
| **六层压缩管线** | `src/host/context/layers/` + `compressionPipeline.ts` | L1 tool-result budget → L2 snip → L3 microcompact → L4 contextCollapse → L5 autocompact → L6 overflow recovery |
| **多分支决策引擎** | `src/host/agent/loopDecision.ts` | 每轮显式决策 continue/compact/continuation/fallback/terminate，含 max_tokens 续写协议 |
| **错误分类器** | `src/host/model/errorClassifier.ts` | 6 类错误分类（overflow/rate_limit/auth/network/unavailable/unknown）驱动恢复决策 |
| **缓存稳定性** | `src/host/prompts/cacheBreakDetection.ts` | DYNAMIC_BOUNDARY_MARKER 切分可缓存前缀和动态段，跨轮缓存不失效 |
| **/context 命令** | `src/host/ipc/context.ipc.ts` + `ContextPanel.tsx` | 展示 API 真实视图（经投影后）、token 分布、压缩状态 |

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
| **Overlay 引擎** | `src/host/prompts/overlayEngine.ts` | 5 层叠加（substrate → mode → memory → append → projection），每层独立可开关 |
| **Prompt Profile** | `src/host/prompts/profiles.ts` | 4 种入口 profile（interactive/oneshot/subagent/fork）各有独立 overlay 组合 |
| **子 Agent 上下文重建** | `src/host/agent/childContext.ts` | `buildChildContext()` 从父上下文派生完整子运行时（prompt/tools/permissions/hooks/memory） |
| **Agent Registry** | `src/host/agent/agentRegistry.ts` | 用户/项目 `.code-agent/agents/*.md` 与 builtin agent 合并；project > user > builtin；spawn、Task、CLI、@mention、StatusBar 共用 |
| **AgentTask 状态机** | `src/host/agent/agentTask.ts` | 7 态生命周期（pending→registered→running→stopped→resumed→failed→cancelled）+ transcript 持久化 |
| **Agent Team durable mailbox** | `src/host/agent/agentTeamDurableTypes.ts` + `agentTeamDurableAdapter.ts` + `parallelAgentCoordinator.ts` | 按 session/run/tree 隔离的耐久 pending-message 队列，承载 parent/user→单个 child 的定向 steering；消息注入后经 ack 才消费并从 checkpoint 删除 |

### M3: 权限矩阵 + 事件分层 + 连续性协议

| 模块 | 位置 | 描述 |
|------|------|------|
| **GuardFabric** | `src/host/permissions/guardFabric.ts` | 多源竞争（Rules + Mode + Hooks + Classifier + UserConfigSource），deny > ask > allow，first-valid-wins |
| **拓扑感知** | guardFabric 内置 | main/async_agent/teammate/coordinator 各有不同裁决（async_agent+bash→deny） |
| **Subagent 权限继承** | `src/host/agent/childContext.ts` + `src/host/permissions/userConfigSource.ts` | 默认 `strict-inherit`；tools 交集、deny 并集、mode 取严；用户 deny/ask/allow 级联 |
| **事件基础设施** | `src/host/services/eventing/bus.ts` + `internalStore.ts` | EventBus 负责运行时派发，InternalEventStore 负责持久化事件存储 |
| **Worker Epoch** | `src/host/session/workerEpoch.ts` | 生成代围栏防止并发写入，`guardedWrite()` 校验 epoch 一致性 |
| **Rematerialization** | `src/host/session/workerEpoch.ts` | 从快照投影恢复（非 transcript 逐条回放），`checkResumeConsistency()` 一致性检查 |

### M4: 多模型路由整合 + Operator Surface（差异化增强）

| 模块 | 位置 | 描述 |
|------|------|------|
| **压缩模型路由** | `src/host/context/compressionModelRouter.ts` | L4→zhipu/glm-4-flash（最便宜），L5→moonshot/kimi-k2.5（更强摘要），L1-L3→null |
| **智能 Fallback** | `src/host/model/adaptiveRouter.ts` | `selectFallback()` 按失败原因选择：overflow→更大窗口，rate_limit→换 provider |
| **Agent 模型策略** | `src/host/agent/agentModelPolicy.ts` | 按 agent 类型分配模型（Explorer→Kimi 128k, Reviewer→DeepSeek R1, Search→Perplexity） |
| **请求规范化** | `src/host/model/middleware/requestNormalizer.ts` | 统一消息格式转换、工具 schema 适配、beta flags、缓存 TTL |
| **TokenWarning** | `src/renderer/components/TokenWarning.tsx` | 动态指示器：绿(<60%)→黄(60-85%)→黄脉冲(压缩中)→红(overflow/fallback) |
| **ContextVisualization** | `src/renderer/components/ContextVisualization.tsx` | token 分布柱状图 + 压缩时间线 + 活跃 agent + deferred tools |
| **/doctor 诊断** | `src/host/diagnostics/doctorRunner.ts` + `src/shared/commands/definitions/doctorCommands.ts` | 9 类 / 24 项健康检查，CLI 和 GUI 共用 `DoctorReport`，结构化 pass/warn/fail/skip 报告 |

---

## v0.16.55 新增模块

### Agent Team — 并行多代理自主拆分（2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **SpawnGuard** | `src/host/agent/spawnGuard.ts` | RAII 风格并发守卫（max 6 agents, max depth 1），19 个禁用工具 + 只读工具限制 |
| **并行执行** | `src/host/tools/multiagent/spawnAgent.ts` | `executeParallelAgents` 容量检查 + 依赖解析（role→id 映射）+ 结果聚合 |
| **结果聚合** | `src/host/agent/resultAggregator.ts` | 3 种正则提取变更文件、计算 speedup ratio、汇总成本 |
| **活跃上下文** | `src/host/agent/activeAgentContext.ts` | `<active_subagents>` XML 注入 + `drainCompletionNotifications()` 异步通知 |
| **Git Worktree** | `src/host/agent/agentWorktree.ts` | `/tmp/code-agent-worktrees/{agentId}` 隔离，coder 独立分支，无变更自动清理 |
| **wait_agent** | `src/host/tools/multiagent/waitAgent.ts` | 等待指定子代理完成（支持超时） |
| **close_agent** | `src/host/tools/multiagent/closeAgent.ts` | 取消运行中的子代理（AbortController） |
| **send_input** | `src/host/tools/multiagent/sendInput.ts` | 向运行中子代理发送消息（消息队列，executor 每轮消费） |
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
| **Excel 原子编辑** | `src/host/tools/excel/excelEdit.ts` | 14 种操作（set_cell/range/formula, insert/delete rows/columns, style, sheet 管理） |
| **Word 原子编辑** | `src/host/tools/modules/document/docEdit.ts` | 历史 7 种 Word 操作经 DocEdit native 入口承接，旧 `docxEdit.ts` 不再作为当前事实源 |
| **SnapshotManager** | `src/host/tools/document/snapshotManager.ts` | 统一文档快照层（创建/恢复/清理，最多 20 个/文件） |
| **DocEdit 统一入口** | `src/host/tools/modules/document/docEdit.ts` | 自动识别格式（.xlsx/.pptx/.docx）路由到对应引擎 |
| **PPT 编辑加固** | `src/host/tools/modules/network/pptEdit.ts` | +2 新操作（reorder_slides, update_notes），接入 SnapshotManager；生成/版式能力在 `src/host/tools/media/ppt/` |

**设计原则**：原子操作替代全量重写，~80% token 节省。编辑前自动快照到 `.doc-snapshots/`，失败自动回滚。对标悟空 RealDoc。

### Generative UI（2026-03-17）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChartBlock** | `src/renderer/.../MessageBubble/ChartBlock.tsx` | Recharts 6 种图表渲染（bar/line/area/pie/radar/scatter），暗色主题 |
| **GenerativeUIBlock** | `src/renderer/.../MessageBubble/GenerativeUIBlock.tsx` | 沙箱 iframe HTML 小程序渲染（sandbox="allow-scripts"） |
| **Generative UI Prompt** | `src/host/prompts/generativeUI.ts` | System Prompt 注入，教 AI 何时使用 chart vs generative_ui |
| **Artifact 类型** | `src/shared/types/message.ts` | 版本化可视化产物追踪（chart/generative_ui） |

**渲染路由**：MessageContent 的 markdown code block handler 检测 `chart` / `generative_ui` 语言标签，路由到对应 React 组件（与已有 `mermaid` 路由同一模式）。

### Combo Skills（组合技能）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ComboSkillCard** | `src/renderer/.../ChatInput/ComboSkillCard.tsx` | 输入框中的组合技能卡片 UI |
| **Skill IPC** | `src/host/ipc/skill.ipc.ts` | Combo Skill 调度 |

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
| **Index Loader** | `src/host/lightMemory/indexLoader.ts` | 加载 `~/.code-agent/memory/INDEX.md` 到 system prompt |
| **MemoryWrite 工具** | `src/host/lightMemory/memoryWriteTool.ts` | 写入/删除记忆文件 + 自动维护索引 |
| **MemoryRead 工具** | `src/host/lightMemory/memoryReadTool.ts` | 按需读取记忆详情 |
| **Session Metadata** | `src/host/lightMemory/sessionMetadata.ts` | 追踪使用频率/模型分布（借鉴 ChatGPT） |
| **Recent Conversations** | `src/host/lightMemory/recentConversations.ts` | ~15 条近期对话摘要（借鉴 ChatGPT） |
| **前端面板** | `src/renderer/.../settings/tabs/MemoryTab.tsx` | Light Memory 文件浏览器（替代旧 10+ 组件） |
| **IPC 服务** | `src/host/lightMemory/lightMemoryIpc.ts` | 列出/读取/删除记忆文件 + 综合统计 |
| **会话判定（WS4-A, 2026-05-27）** | `src/host/lightMemory/conversationJudge.ts` | 会话收尾（`runFinalizer`）用 quick model 判 `worth/isMeeting/title/worthKnowledge`，过滤无价值对话（打招呼/确认）；async fire-and-forget 不阻塞；失败回退 `heuristicJudgment`。常量 `SESSION_JUDGE` |
| **记忆整理（WS4-B, 2026-05-27）** | `src/host/lightMemory/consolidation.ts` | 周期压缩：gate 判定是否触发（INDEX>200 行 / 重复 name·description / 文件数≥40），quick model 生成合并计划，信息无损 guard 拒绝孤立删除 + 净删上限闸；默认 dry-run。常量 `MEMORY_CONSOLIDATION` |
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
| **视觉分析器** | `src/host/services/desktopVisionAnalyzer.ts` | 后台轮询截图，调用智谱 GLM-4V-Plus 生成语义描述 |
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
| **混合 Agent 架构** | `src/host/agent/hybrid/` | 3 层：核心角色 + 动态扩展 + Swarm |
| **内置 Agent** | `src/shared/types/builtInAgents.ts` | 6+11 个预定义 Agent 角色 |
| **Agent 团队** | `src/host/agent/teammate/` | 持久化团队、生命周期管理（create/resume/snapshot/shutdown） |
| **SpawnGuard** | `src/host/agent/spawnGuard.ts` | 并发守卫（max 6 agents）+ 通知队列 + 消息队列 + 只读工具限制 |
| **Result Aggregator** | `src/host/agent/resultAggregator.ts` | 子代理结果聚合（文件提取、加速比计算、成本汇总） |
| **Active Agent Context** | `src/host/agent/activeAgentContext.ts` | 运行中子代理 XML 注入 + 异步完成通知 |
| **Agent Worktree** | `src/host/agent/agentWorktree.ts` | Git worktree 隔离（coder 角色独立分支，无变更自动清理） |
| **优雅关闭** | `src/host/agent/shutdownProtocol.ts` | 4 阶段关闭（Signal→Grace→Flush→Force） |
| **跨 Agent 审批** | `src/host/agent/planApproval.ts` | 高风险操作 plan → Coordinator 审批（可选） |
| **Adaptive Thinking** | `src/host/agent/agentLoop.ts` | InterleavedThinkingManager + effort 级别控制 |
| **Delegate 模式** | `src/host/agent/agentOrchestrator.ts` | Orchestrator 只分配不执行 |
| **h2A 实时转向** | `src/host/agent/agentLoop.ts` | `steer()` 注入用户消息，保留中间状态 |

### 工具与调度

| 模块 | 位置 | 描述 |
|------|------|------|
| **DAG 调度器** | `src/host/scheduler/` | 基于 DAG 的并行任务调度 |
| **工具 DAG** | `src/host/agent/toolExecution/dagScheduler.ts` | 文件依赖 DAG + Kahn 拓扑排序 |
| **ToolSearch** | `src/host/tools/gen4/toolSearch.ts` | 延迟加载工具发现机制 |
| **Checkpoint** | `src/host/services/FileCheckpointService.ts` | 文件版本快照与回滚 |
| **Skills 系统** | `src/host/skills/` | 用户可定义技能 + 数据清洗 Skill |

### 上下文与记忆

| 模块 | 位置 | 描述 |
|------|------|------|
| **投影式上下文管理** | `src/host/context/` | 6 层压缩管线（tool-result budget → snip → microcompact → contextCollapse → autocompact → overflow recovery），投影架构：transcript 不可变，CompressionState 追踪，ProjectionEngine 查询时生成 API 视图 |
| **文档上下文** | `src/host/context/documentContext/` | 统一文档理解层，5 种解析器 |
| **DataFingerprint** | `src/host/tools/dataFingerprint.ts` | 源数据锚定（xlsx schema + CSV/JSON schema） |
| **FileReadTracker** | `src/host/tools/fileReadTracker.ts` | 文件读取记录，支持编辑验证和恢复上下文 |

### 模型与路由

| 模块 | 位置 | 描述 |
|------|------|------|
| **自适应路由** | `src/host/model/adaptiveRouter.ts` | 简单任务 → glm-4-flash（免费），失败原因感知 fallback（overflow→更大窗口，rate_limit→换 provider） |
| **推理缓存** | `src/host/model/inferenceCache.ts` | LRU 缓存（50 条，5min TTL） |
| **错误恢复引擎** | `src/host/errors/recoveryEngine.ts` | 6 种错误模式自动恢复 |
| **Moonshot Provider** | `src/host/model/providers/moonshot.ts` | Kimi K2.5 / Kimi K2.6 SSE 流式支持 |

### 工程能力

| 模块 | 位置 | 描述 |
|------|------|------|
| **引用溯源** | `src/host/services/citation/` | 自动提取引用（文件行号/URL/单元格） |
| **确认门控** | `src/host/agent/confirmationGate.ts` | 写操作前 diff 预览 + 确认 |
| **变更追踪** | `src/host/services/diff/diffTracker.ts` | 结构化 unified diff |
| **模型热切换** | `src/host/session/modelSessionState.ts` | 对话中途切换模型 |
| **安全校验** | `src/host/security/inputSanitizer.ts` | prompt injection 检测 |

### 评测 / 回放基础设施

> v0.16.79 移除了 per-session grader + 失败漏斗 + evalCenter UI 死代码（评测双管道、SwissCheese 评估器、deliveryReview / previewFeedback 一并删除）。`src/host/evaluation/` 现仅保留下面的 trajectory / replay / telemetry / experiment 活路径，telemetry IPC / agentOrchestrator / bug-report replay 仍依赖；外部评测用 `packages/eval-harness/`。

| 模块 | 位置 | 描述 |
|------|------|------|
| **Session Replay** | `src/host/evaluation/replayService.ts` + `transcriptReplayBuilder.ts` | 结构化会话回放 |
| **Trajectory 采集** | `src/host/evaluation/trajectory/` | 轨迹记录 |
| **Telemetry Query** | `src/host/evaluation/telemetryQueryService.ts` | 遥测查询（意图分类、缓存、replay 完整度证据）|
| **Experiment Adapter** | `src/host/evaluation/experimentAdapter.ts` | `experiments` / `experiment_cases` 实验跟踪 |
| **Session Event** | `src/host/evaluation/sessionEventService.ts` | `session_events` 落库 |
| **Eval Harness** | `packages/eval-harness/` | 外部评测框架（独立于 app 运行时）|

### 基础设施

| 模块 | 位置 | 描述 |
|------|------|------|
| **统一配置** | `src/host/config/configPaths.ts` | `.code-agent/` 配置目录结构 |
| **基础设施服务** | `src/host/services/infra/` | 磁盘监控、文件日志（NDJSON + 按日轮转）、优雅关闭 |
| **CLI 运行时** | `src/cli/` | 5 模式（chat/run/serve/exec-tool/mcp-server）、CLIAgent 适配层 |
| **多渠道接入** | `src/host/channels/` | 飞书 Webhook 等渠道支持 |

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
| **2026-06-26** | Neo Tools Evidence + Pointer | `EvidenceRef` 成为统一证据底座；goal gate 输出 verification card；Browser/Computer/Screenshot 结果持久化 proof timeline；Browser/Computer surface 显示 Neo virtual pointer；background task/subagent restart recovery plan 进入 replay/export；agent tree/worktree review 保持 read-only |

</details>

---

## 如何使用本文档

1. **新人入门**: 先阅读 [系统概览](./architecture/overview.md)
2. **开发功能**: 查阅对应模块的详细文档
3. **理解决策**: 查看 ADR 了解架构决策背景
4. **贡献代码**: 遵循各文档中的设计原则

## 更多文档

- [Release Notes](./releases/) — 版本发布记录
- 工具参考手册 — 全部工具的完整文档
- 模型配置矩阵 — 模型路由与配置
- 评测系统指南 — 评测工程详细文档
- ADR-005: Eval Engineering — 评测关键工程决策

### 历史功能设计摘要

- /goal 模式设计 — Goal Mode 三层闸（as-built 校准）
- Appshots 设计 — 窗口快照 → 多模态上下文（macOS）
- 附件管线 v2 设计 — 多类型附件 → 端侧摘要 → 模型上下文（🚧 wip，待 review）
