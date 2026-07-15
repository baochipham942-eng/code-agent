# 仓库导览

这份文档写给第一次打开 Agent Neo GitHub 仓库的人。它帮你判断每个目录大概放什么，以及遇到一个产品能力时该从哪里继续看。

## 这个仓库放了什么

Agent Neo 的主产品是一个本地优先的桌面应用。仓库里同时保留了几类配套工程：

| 类型 | 目录 | 用途 |
|------|------|------|
| 桌面主产品 | `src/`、`src-tauri/` | 应用主体、前端界面、后端主进程、Tauri 桌面外壳 |
| 本地桥和复用包 | `packages/` | 本地 bridge、评测 harness 等可以独立维护的子包 |
| 官网和更新服务 | `vercel-api/`、`public/code-agent/` | 下载页、更新 API、控制面 API |
| 管理后台 | `admin-console/` | 读取 telemetry、错误、反馈，用于定位外部分发后的问题 |
| 数据库和云函数 | `supabase/` | 迁移、RLS、函数 |
| 浏览器扩展 | `extension/`、`resources/browser-relay-extension/` | 浏览器侧辅助能力 |
| 评测和样本 | `benchmarks/`、`packages/eval-harness/`、`tests/eval/` | 外部 benchmark、评测框架、评测相关测试 |
| 产物知识 | `artifact-knowledge/` | 给游戏、演示稿、数据看板等产物生成和验收提供参考知识 |
| 发布锁定配置 | `config/` | 经评审、可入库的发布制品锁；不存放用户运行时配置或 secret |
| 文档 | `docs/` | 架构、部署、API、发布记录 |

## 当前仓库形态

当前采用“一个根应用 + 多个配套工程”的组织方式，根 `package.json` 是 Agent Neo 主应用的构建入口，暂未启用 npm workspaces。

- `src/`、`src-tauri/` 属于主应用。
- `admin-console/` 是独立部署的管理应用，有自己的 `package.json`。
- `packages/bridge/`、`packages/eval-harness/` 是独立维护的复用包。
- `vercel-api/`、`supabase/` 是部署和数据基础设施，不作为根应用源码子目录。

在正式迁移到 `apps/ + packages/ + infra/` 前，不新增新的根级应用目录；新产品面先判断能否进入现有主应用、配套工程或 `packages/`。

## 代码主体怎么分

| 目录 | 用途 |
|------|------|
| `src/host/` | 后端主进程。Agent 运行时、工具、模型、权限、记忆、任务、评测都在这里。 |
| `src/renderer/` | 前端界面。React 组件、状态、hooks、设置页、设计工作区 UI 都在这里。 |
| `src/shared/` | 前后端共享的类型、契约、常量。改接口时通常要看这里。 |
| `src/web/` | 本地 web server，负责 renderer 和 host 之间的 HTTP/SSE 桥。 |
| `src/cli/` | 命令行入口和 CLI Agent 适配层。 |
| `src/design/` | 设计工作区相关的共享逻辑。 |
| `src/artifacts/` | 产物类型、产物处理、产物状态相关逻辑。 |

`src/host/` 子域很多，具体“改什么去哪儿”见 [source-map.md](./source-map.md)。

高密度目录还有各自的就近说明：

- [`src/host/README.md`](../../src/host/README.md)：host 一级域边界和放置规则
- [`tests/README.md`](../../tests/README.md)：测试层级与历史目录收口规则
- [`scripts/README.md`](../../scripts/README.md)：脚本分类、稳定入口和命名规则
- [`.github/README.md`](../../.github/README.md)：workflow 职责地图和维护规则

## 能力体系词汇表

Agent Neo 里有几组词容易混。它们都和“让 Agent 做事”有关，但生命周期不同。

| 名字 | 用户看到的样子 | 代码入口 |
|------|----------------|----------|
| Tool | Agent 在对话里调用的单个动作，比如读文件、改文件、打开浏览器、发消息。 | `src/host/tools/` |
| Connector | 接本机应用或外部服务的连接层，比如日历、邮件、提醒事项。 | `src/host/connectors/`、`src/host/services/connectors/` |
| MCP | 通过 Model Context Protocol 接外部工具服务器。 | `src/host/mcp/` |
| Plugin | 一组可安装或内置的扩展能力，通常会提供多个工具或配置。 | `src/host/plugins/` |
| Skill | 给 Agent 的任务说明和操作套路。仓库内置技能在 `.agents/skills/`，用户安装技能在 `~/.code-agent/skills/`。 | `src/host/services/skills/`、`src/host/skills/marketplace/` |
| Capability | 产品层的能力卡片和能力目录，用来告诉用户当前 Neo 会做什么、缺什么。 | `src/host/services/capabilities/`、`docs/capabilities/` |
| Artifact Knowledge | 产物知识包。它给某类产物补充生成和验收知识，比如平台跳跃游戏的玩法规则。 | `artifact-knowledge/` |

## 评测目录怎么分

| 目录 | 用途 |
|------|------|
| `src/host/evaluation/` | 产品里的回放、轨迹、遥测查询、实验适配。 |
| `packages/eval-harness/` | 可复用的外部评测框架。 |
| `benchmarks/` | SWE-bench、Excel benchmark 这类外部 benchmark 的 runner 和样本。 |
| `tests/eval/` | 评测相关测试。 |

根目录没有单独的 `eval/`。看到旧文档提到 `eval/` 时，按上面四类实际目录查。

## 配置目录怎么读

| 目录 | 用途 |
|------|------|
| `.agents/` | 产品内置 Agent 能力和任务技能。 |
| `.claude/` | 开发本仓库时给 Claude Code 使用的本地协作配置。 |
| `.github/workflows/` | GitHub Actions，包含发布、bundle、CI、控制面验证等流程。 |
| `config/` | 公开、可评审的发布锁定配置；当前用于锁定 Poppler 不可变制品与源码证据。 |
| `.husky/` | Git hooks。 |

这些目录都在仓库里，但面向的对象不同。看产品运行时能力，优先看 `.agents/`、`src/host/services/skills/` 和 `src/host/tools/`；看开发协作约束，再看 `.claude/`。
