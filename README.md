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

## 目录结构

顶层：

```
code-agent/
├── src/            # 应用源码（见下方 src/ 说明）
├── docs/           # 架构 / 产品 / 指南文档（入口：docs/ARCHITECTURE.md）
├── tests/          # 测试
├── scripts/        # 构建 / 运维 / 验收脚本
├── packages/       # 子包（如本地桥接 bridge）
├── skills/         # 内置技能
├── eval/           # 评测 harness 与数据
├── src-tauri/      # Tauri (Rust) 外壳
├── extension/      # 浏览器扩展
├── admin-console/  # 管理后台
├── supabase/       # 数据库迁移 / 函数
└── vercel-api/     # 更新 API（Vercel）
```

`src/` 一级分层：

| 目录 | 职责 |
|------|------|
| `src/host/` | 后端/主进程：Agent 运行时、工具、上下文、记忆、安全、服务等（详见 [源码地图](docs/architecture/source-map.md)） |
| `src/renderer/` | 前端：React 组件、Zustand store、hooks、i18n、样式 |
| `src/shared/` | 前后端共享：类型、契约（contract）、常量 |
| `src/web/` | webServer（renderer 与 host 间的本地 HTTP/SSE 桥） |
| `src/cli/` | 命令行入口与 CLIAgent 适配层 |
| `src/design/` | 设计工作区相关共享逻辑 |
| `src/artifacts/` | 产物（artifact）相关类型与处理 |

> `src/host/` 子域较多，按「逻辑分组 + 一句话职责」的导览见 **[docs/architecture/source-map.md](docs/architecture/source-map.md)**。

## 文档

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 架构索引入口（系统概览、Agent 核心、工具系统、前端、数据存储、多 Agent、设计工作区、ADR 等）
- **[docs/architecture/source-map.md](docs/architecture/source-map.md)** — `src/host` 源码地图（按逻辑分组）
- **[docs/architecture/](docs/architecture/)** — 各子系统深入文档（agent-core / tool-system / multiagent-system / data-storage / hot-update / windows-support 等）
- **[docs/api-reference/](docs/api-reference/)** · **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — API 参考与部署
- `CLAUDE.md` — 工程规范、发版流程、常用命令

> 架构决策（ADR）记录见 `docs/ARCHITECTURE.md` 的决策表；PRD / 产品策略类文档不进公开仓库。

## 状态

活跃迭代中，主要面向研究与自用 dogfood。架构与能力以 `docs/ARCHITECTURE.md` 的版本演进记录为准。
