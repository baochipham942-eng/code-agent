# Agent Neo

> 人机协作（cowork）的桌面 Agent 应用——人和 AI 一起把各类工作做成**产物**（网页 / 设计稿 / 演示稿 / 视频 / 数据分析 / 文档等），多模型、多工作面。
>
> 仓库代号 **code-agent**（历史名，沿用至今）；产品名为 **Agent Neo**。

---

## 这是什么

Agent Neo 是一个本地优先的桌面应用：你给目标，AI 在可监督、可干预的协作回路里产出可交付的产物，而不是只回一段文字。它围绕「产物」组织体验，提供多个工作面（surface）：

- **对话工作台**：主链路聊天 + 内联能力工作台（Workbench），可直接出活，不必先开侧面板。
- **设计画布**：konva 无限画布，文生图 / 圈选局部重绘 / 标注重绘 / 扩图去水印 / A·B 对比 / 演示稿 / 图生视频。
- **任务与多 Agent**：长任务后台执行、Agent Team 并行编排、DAG 调度、可恢复的后台任务账本。
- **自动化**：定时（cron）/ 循环任务、心跳、到点通知。
- **产物验证**：Game / Deck / Dashboard 等产物的自动校验与修复闭环。

工程上它复刻并研究了现代 Agent 架构（Agent Loop、工具系统、上下文工程、记忆分层、Eval 驱动），用作 AI Agent 能力演进的实验场。

## 技术栈

| 层级 | 选型 |
|------|------|
| 桌面框架 | Tauri 2.x (Rust) |
| 前端 | React 18 + TypeScript 5.6 + Zustand 5 + Tailwind 3.4 |
| 构建 | esbuild（main/preload）+ Vite（renderer） |
| 本地存储 | SQLite (better-sqlite3) |
| 云端 | Supabase + pgvector |
| AI 模型 | 多 provider 目录（MiMo / GPT / DeepSeek / Kimi / 智谱 / 火山 / 本地 Ollama 等），本地 API Key 优先 |
| Agent Engine | Native / Codex CLI / Claude Code / MiMo / Kimi 多执行内核 |

## 快速开始

前置：Node（见 `.node-version`）、Rust 工具链（`source ~/.cargo/env`）、Xcode Command Line Tools；国际 API 走代理 `HTTPS_PROXY=http://127.0.0.1:7897`。

```bash
npm install
npm run typecheck            # 类型检查
npm run dev                  # 开发模式（web server + renderer）
cargo tauri dev             # 完整桌面开发模式（需代理）
```

构建 / 打包：

```bash
npm run build                # 构建 main/preload
npm run build:web            # Web 构建（Tauri 前端）
npm run build:cli            # CLI 构建（独立）
cargo tauri build           # 打包 macOS（~33MB DMG）
```

> 正式发版不在本地打包：推 `v<version>` tag 触发 GitHub Actions 完成多平台签名/公证/发布。详见 `CLAUDE.md` 的「发版」一节。

## 怎么读这个仓库

Agent Neo 是主产品。这个仓库里还放了桌面壳、官网和更新服务、管理后台、评测套件、浏览器扩展等配套工程。第一次打开仓库，可以先按这个顺序看：

| 想看什么 | 去哪里 |
|----------|--------|
| 产品和架构概览 | `README.md`、`docs/ARCHITECTURE.md` |
| 应用主体代码 | `src/` |
| 桌面 App 外壳 | `src-tauri/` |
| 官网、下载页、更新 API | `vercel-api/`、`public/code-agent/` |
| 管理后台 | `admin-console/` |
| 外部评测和跑分 | `benchmarks/`、`packages/eval-harness/` |
| 更细的目录导航 | `docs/architecture/repo-map.md`、`docs/architecture/source-map.md` |

顶层目录大致是这样：

```
code-agent/
├── src/                  # 应用主体：后端主进程、前端、共享类型、本地 web 桥、CLI
├── src-tauri/            # Tauri 桌面外壳和 Rust 原生能力
├── docs/                 # 架构、部署、API、发布记录
├── tests/                # 单测、组件测试、E2E、smoke
├── scripts/              # 构建、发布、诊断、验收脚本
├── packages/             # 可独立复用的子包，如本地 bridge、eval harness
├── artifact-knowledge/   # 产物知识包，给游戏、演示稿等产物生成和校验使用
├── benchmarks/           # 外部 benchmark 数据和 runner，如 SWE-bench、Excel benchmark
├── extension/            # 浏览器扩展
├── admin-console/        # 管理后台，用于排查外部分发后的 telemetry 和反馈
├── supabase/             # 数据库迁移和云函数
└── vercel-api/           # 官网、下载入口、更新 API、控制面 API
```

有几个名字容易混在一起，先按这一层理解：

| 名字 | 位置 | 用途 |
|------|------|------|
| Agent 能力技能 | `.agents/skills/` | 随仓库内置的任务能力，比如 docx、excel、ppt、pr。Agent 做这些任务时会读取。 |
| Claude Code 开发配置 | `.claude/skills/`、`.claude/rules/` | 开发本仓库时给 Claude Code 用的规则和技能。它不属于产品运行时。 |
| 用户安装技能 | `~/.code-agent/skills/` | 用户机器上的运行时技能，来自安装或 marketplace。 |
| 技能系统代码 | `src/host/services/skills/`、`src/host/skills/marketplace/` | 产品里负责发现、安装、解析、执行技能的代码。 |
| 产物知识包 | `artifact-knowledge/` | 给特定产物类型提供生成和验收知识，例如 platformer game。它和用户安装技能分属两层。 |

### `src/` 一级分层

| 目录 | 职责 |
|------|------|
| `src/host/` | **后端/主进程（核心）**：Agent 运行时、工具、上下文、记忆、安全、服务等（详见下方「src/host」小节） |
| `src/renderer/` | 前端：React 组件、Zustand store、hooks、i18n、样式 |
| `src/shared/` | 前后端共享：类型、契约（contract）、常量 |
| `src/web/` | webServer（renderer 与 host 间的本地 HTTP/SSE 桥） |
| `src/cli/` | 命令行入口与 CLIAgent 适配层 |
| `src/design/` | 设计工作区相关共享逻辑 |
| `src/artifacts/` | 产物（artifact）相关类型与处理 |

### `src/host` —— 后端/主进程（最核心）

整个项目最核心的目录，40+ 子域。按逻辑分组概览如下，完整的「在哪改」导航见 **[docs/architecture/source-map.md](docs/architecture/source-map.md)**：

| 分组 | 主要子目录 |
|------|-----------|
| **Agent 运行核心** | `agent/`（Agent Loop 与运行时）· `loop/` · `routing/`（意图分类/路由）· `model/`（模型路由/provider 适配）· `protocol/` · `planning/`（自动规划） |
| **任务 / 编排 / 会话** | `task/`（并发闸 + 后台任务账本）· `scheduler/`（DAG 调度）· `cron/`（定时/心跳）· `handoff/`（任务交接/长任务恢复）· `session/` · `cowork/`（人机协作契约） |
| **工具 / 能力 / 外部集成** | `tools/`（工具注册与执行）· `skills/` · `mcp/` · `connectors/` · `plugins/` · `lsp/` · `desktop/`（Computer Use）· `sandbox/` · `research/` · `channels/`（飞书等外部通道） |
| **上下文 / 记忆 / 提示词** | `context/`（上下文工程/压缩）· `memory/` · `lightMemory/`（轻记忆/失败日志）· `prompts/` |
| **质量 / 评测 / 观测** | `evaluation/`（**评测引擎**：实验适配/会话质量评分/回放/遥测查询）· `quality/`（产物质量检测）· `observability/` · `telemetry/` · `diagnostics/` · `testing/` · `hooks/` |
| **平台 / 基础设施** | `app/`（应用宿主/bootstrap）· `platform/` · `runtime/`（运行时资产）· `ipc/`（renderer↔host）· `services/`（core/infra/design/agentEngine 等）· `config/` · `security/` · `permissions/` · `errors/` · `extension/` · `utils/` |

评测相关目录有四类：`src/host/evaluation/` 是产品里的回放、轨迹、遥测和实验适配；`packages/eval-harness/` 是可复用的外部评测框架；`benchmarks/` 放外部 benchmark 的 runner 和样本；`tests/eval/` 放评测相关测试。

## 文档

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 架构索引入口（系统概览、Agent 核心、工具系统、前端、数据存储、多 Agent、设计工作区、ADR 等）
- **[docs/architecture/repo-map.md](docs/architecture/repo-map.md)** — 面向第一次浏览仓库的人：根目录、运行面、能力体系、评测目录怎么分
- **[docs/architecture/source-map.md](docs/architecture/source-map.md)** — `src/host` 源码地图（按逻辑分组）
- **[docs/architecture/](docs/architecture/)** — 各子系统深入文档（agent-core / tool-system / multiagent-system / data-storage / hot-update / windows-support 等）
- **[docs/api-reference/](docs/api-reference/)** · **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — API 参考与部署
- **[src/host/README.md](src/host/README.md)** · **[tests/README.md](tests/README.md)** · **[scripts/README.md](scripts/README.md)** · **[.github/README.md](.github/README.md)** — 高密度目录的就近边界与维护规则
- `CLAUDE.md` — 工程规范、发版流程、常用命令

> 架构决策（ADR）记录见 `docs/ARCHITECTURE.md` 的决策表；PRD / 产品策略类文档不进公开仓库。

## 状态

活跃迭代中，主要面向研究与自用 dogfood。架构与能力以 `docs/ARCHITECTURE.md` 的版本演进记录为准。
