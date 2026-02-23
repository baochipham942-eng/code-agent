# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 的 8 个架构代际来研究 AI Agent 能力演进。

## 项目上下文

当我提到 'code agent'、'ai-code-agent' 或 'coda agent' 时，我指的是我自己的本地项目（ai-code-agent）— 不是 Claude Code 或其他外部产品。总是先检查本地工作区再分析外部工具。

这个项目主要使用 TypeScript（辅以 HTML 报告和少量 JavaScript）。主要语言是 TypeScript — 除非明确告知，否则新文件都使用 TypeScript。

## 项目架构分层

本项目有两个明确的层次：
- **工程层**（core）：agentLoop、tools、context、scheduler、hooks、security 等核心基础设施
- **技能层**（skills）：PPT 生成、Excel 分析、数据分析等领域技能

分类或分析功能时必须尊重这个分层。excelAnalyze、excelEdit、pptGenerator 等属于**技能层**，不是工程层。

## 沟通规则

当我分享截图或参考材料时，假设它们与我们当前讨论的内容相关，除非我明确说明。不要为它们编造独立的上下文。

当我给出简短中文指令（如"帮我实现"、"继续"），先检查当前上下文中的计划、PRD 或任务列表，直接执行下一项。不要因为指令简短就停下来问澄清问题。

## 调试指南

调试时，不要进入试错循环。同一问题 2 次修复失败后，停下来从头重新分析根因，再尝试下一次修复。

## 工作流要求

实现功能或修复 Bug 后，在提交前必须运行 `tsc --noEmit`（类型检查）。如果修改区域有测试，也要运行测试。类型检查通过前不要宣布任务完成。

## 技术栈

- **框架**: Electron 38 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS
- **状态**: Zustand
- **AI**: Moonshot Kimi K2.5（主）, 智谱/DeepSeek/OpenAI（备）
- **后端**: Supabase + pgvector

## 文档导航

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构索引（入口）|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/guides/tools-reference.md](docs/guides/tools-reference.md) | 工具完整参考手册 |
| [docs/guides/model-config.md](docs/guides/model-config.md) | 模型配置矩阵 |
| [docs/guides/deployment.md](docs/guides/deployment.md) | 部署配置指南 |
| [docs/guides/git-workflow.md](docs/guides/git-workflow.md) | Git 分支工作流 |
| [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md) | 问题排查（错题本）|
| [docs/guides/ppt-capability.md](docs/guides/ppt-capability.md) | PPT 生成系统能力文档 |

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   │   ├── hybrid/      # 🆕 混合架构 (v0.16.18+) - 4核心角色+动态扩展+Swarm
│   │   ├── teammate/    # 🆕 团队协作 (v0.16.19+) - 通信+持久化+团队管理
│   │   ├── taskList/    # 🆕 任务列表管理 (v0.16.21+) - 可视化任务追踪+IPC
│   │   ├── subagent/    # Subagent 旧架构 (v0.16.12+, 已废弃)
│   │   └── recovery/    # 恢复策略 (v0.16.16+)
│   ├── generation/      # GenerationManager, prompts/
│   ├── tools/           # gen1-gen8 工具实现
│   ├── scheduler/       # DAG 调度器 (v0.16+)
│   ├── core/            # DI 容器、生命周期管理
│   ├── config/          # 🆕 统一配置管理 (v0.16.16+)
│   ├── security/        # 安全模块 (v0.9+) + InputSanitizer (v0.16.19+)
│   ├── hooks/           # Hooks 系统 (v0.9+)
│   ├── context/         # 上下文管理 (v0.9+)
│   │   └── documentContext/ # 🆕 文档上下文抽象层 (v0.16.19+)
│   ├── planning/        # 🆕 计划执行系统 (v0.16.16+)
│   ├── session/         # 🆕 模型热切换 (v0.16.19+)
│   ├── services/        # Auth, Sync, Database, FileCheckpoint
│   │   ├── infra/       # 🆕 基础设施服务 (v0.16.16+)
│   │   ├── citation/    # 🆕 引用溯源 (v0.16.19+)
│   │   └── diff/        # 🆕 变更追踪 (v0.16.19+)
│   ├── channels/        # 多渠道接入 (v0.16.11+)
│   ├── skills/          # 用户可定义技能 (v0.16.11+)
│   ├── cli/             # CLI 接口 (v0.16.11+)
│   └── memory/          # 向量存储和记忆系统
├── renderer/            # React 前端
│   ├── components/      # UI 组件
│   │   ├── DiffPanel/          # 🆕 变更追踪面板 (v0.16.19+)
│   │   ├── citations/          # 🆕 引用列表组件 (v0.16.19+)
│   │   ├── features/workflow/  # DAG 可视化
│   │   ├── features/agentTeam/ # 🆕 Agent 团队面板 (v0.16.19+)
│   │   ├── features/swarm/     # 🆕 Swarm 监控 (v0.16.19+)
│   │   └── features/lab/       # 实验室模块
│   ├── stores/          # Zustand 状态
│   │   └── dagStore.ts  # DAG 状态管理
│   └── hooks/           # 自定义 hooks
└── shared/              # 类型定义和 IPC
    └── types/
        ├── taskDAG.ts       # DAG 类型定义
        ├── builtInAgents.ts # 内置 Agent 定义
        ├── workflow.ts      # 工作流类型
        ├── citation.ts      # 🆕 引用类型 (v0.16.19+)
        ├── confirmation.ts  # 🆕 确认门控类型 (v0.16.19+)
        └── diff.ts          # 🆕 Diff 类型 (v0.16.19+)
```

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 构建
npm run dist:mac     # 打包 macOS
npm run typecheck    # 类型检查
```

## 8 代工具演进

| 代际 | 核心能力 | 代表工具 |
|------|----------|----------|
| Gen1 | 基础文件操作 | bash, read_file, write_file, edit_file |
| Gen2 | 代码搜索 | glob, grep, list_directory |
| Gen3 | 任务规划 | task, todo_write, ask_user_question |
| Gen4 | 网络能力 | skill, web_fetch, web_search, mcp |
| Gen5 | 记忆系统 | memory_store, memory_search, ppt_generate |
| Gen6 | 视觉交互 | screenshot, computer_use, browser_action |
| Gen7 | 多代理 | spawn_agent, workflow_orchestrate |
| Gen8 | 自我进化 | strategy_optimize, tool_create |

> 完整工具文档见 [docs/guides/tools-reference.md](docs/guides/tools-reference.md)

## 混合式多 Agent 架构 (v0.16.18+)

基于对 Claude Code、Kimi Agent Swarm、LangGraph 等框架的研究，采用**混合架构**：

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: 核心角色（4 个，覆盖 80% 场景）                            │
│  ┌─────────┬─────────┬─────────┬─────────┐                         │
│  │  coder  │ reviewer│ explore │  plan   │                         │
│  └─────────┴─────────┴─────────┴─────────┘                         │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: 动态扩展（按需生成，覆盖 15% 场景）                        │
│  任务 → 模型分析 → 生成专用 Agent（如 db-designer, sql-optimizer）  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Agent Swarm（复杂任务，覆盖 5% 场景）                      │
│  最多 50 个并行 Agent + 稀疏汇报 + 协调器聚合                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 核心角色（4 个）

| ID | 名称 | 职责 | 模型 |
|----|------|------|------|
| `coder` | Coder | 编码 + 调试 + 文档 + 重构 | powerful (Kimi K2.5) |
| `reviewer` | Reviewer | 审查 + 测试 | balanced (GLM-5) |
| `explore` | Explorer | 搜索代码/网络/文档（只读）| fast (GLM-4.7-Flash) |
| `plan` | Planner | 规划 + 架构设计 | balanced (GLM-5) |

### 别名映射（向后兼容）

旧角色自动映射到核心角色：
- `debugger`, `documenter`, `refactorer` → `coder`
- `tester`, `code-reviewer` → `reviewer`
- `code-explore`, `web-search`, `doc-reader` → `explore`
- `architect`, `planner` → `plan`

### 智能路由

```typescript
// 简单任务 → 核心角色
// 中等任务 → 核心 + 动态扩展
// 复杂任务 → Agent Swarm

const decision = await routeTask({ task: '...' });
switch (decision.type) {
  case 'core': /* 使用核心角色 */ break;
  case 'dynamic': /* 使用动态 Agent */ break;
  case 'swarm': /* 使用 Agent Swarm */ break;
}
```

### 相关文件

```
src/main/agent/hybrid/
├── coreAgents.ts      # 4 个核心角色定义
├── dynamicFactory.ts  # 动态 Agent 工厂
├── taskRouter.ts      # 智能路由器
├── agentSwarm.ts      # 并行执行引擎
└── index.ts           # 统一导出
```

### 设计参考

- [RFC-001: 子代理简化](docs/rfcs/RFC-001-subagent-simplification.md)
- [RFC-002: 混合架构](docs/rfcs/RFC-002-hybrid-agent-architecture.md)
- Claude Code: 6 个能力导向的子代理
- Kimi Agent Swarm: 动态生成 + 稀疏汇报
- LangGraph Send API: 条件路由 + 动态 Worker

### 多 Agent 协作增强 (v0.16.37+)

对标 Claude Code 的 Team/TaskList/Shutdown/PlanApproval 能力，4 个增强模块：

| 模块 | 说明 | 相关文件 |
|------|------|----------|
| **E3 持久化团队** | 团队/任务状态写入 `.code-agent/teams/<id>/`，支持 session 中断恢复 | `teammate/teamPersistence.ts`, `teammate/teamManager.ts` |
| **E4 任务自管理** | 4 核心角色可自行查看/认领/完成/创建任务 | `hybrid/coreAgents.ts`（task 工具注入） |
| **E1 优雅关闭** | 4 阶段关闭（Signal→Grace 5s→Flush→Force），替代暴力中断 | `shutdownProtocol.ts`, `subagentExecutor.ts` |
| **E2 跨 Agent 审批** | 高风险操作（文件删除/破坏性命令）需 Coordinator 审批，可选开启 | `planApproval.ts`, `tools/multiagent/planReview.ts` |

**子 Agent 任务工具分配**：

| 角色 | 任务工具 | 权限 |
|------|---------|------|
| coder, reviewer, plan | `task_list`, `task_get`, `task_update`, `task_create` | 读写 |
| explore | `task_list`, `task_get` | 只读 |

**持久化存储结构**：
```
.code-agent/teams/<team-id>/
├── config.json       # 成员、角色、模型
├── tasks.json        # SessionTask 列表 + counter
├── findings.json     # SharedContext 发现
└── checkpoint.json   # 最后活跃状态
```

---

## 子 Agent 系统 (Gen7) - 旧版

> 注意：以下是旧版 17 角色架构，已被混合架构取代，保留用于向后兼容。

**核心角色（6 个）**：`coder`、`reviewer`、`tester`、`architect`、`debugger`、`documenter`

**扩展角色（11 个）**：

| 分类 | 角色 | 说明 | 映射到 |
|------|------|------|--------|
| 本地搜索 | `code-explore` | 代码库搜索（只读）| explore |
| 本地搜索 | `doc-reader` | 本地文档读取 | explore |
| 外部搜索 | `web-search` | 网络搜索 | explore |
| 外部搜索 | `mcp-connector` | MCP 服务连接 | explore |
| 视觉 | `visual-understanding` | 图片分析 | explore |
| 视觉 | `visual-processing` | 图片编辑 | coder |
| 元 | `plan` | 任务规划 | plan |
| 元 | `bash-executor` | 命令执行 | coder |
| 元 | `general-purpose` | 通用 Agent | coder |
| 代码 | `refactorer` | 代码重构 | coder |
| DevOps | `devops` | CI/CD | coder |

---

## 开发规范

### 验证优先
- 修改代码后必须先验证，确认问题已解决后再通知用户
- 流程：`修改 → 验证 → 确认通过 → 通知`

### 提交纪律
- 每完成一个功能点立即提交，不要积攒
- 归档会话前必须确认所有改动已 commit

### 类型检查
- 写完功能点后立即 `npm run typecheck`
- commit 前 typecheck 必须通过

### 代码品味
- 避免过度工程，只做必要的事
- 不添加未被请求的功能、注释或重构
- 三行重复代码优于一个过早抽象

### 禁止硬编码（强制）

以下值 **必须** 从 `src/shared/constants.ts` 导入，禁止在业务代码中写字面量：

| 值 | 常量名 | 说明 |
|----|--------|------|
| 代际默认值 | `DEFAULT_GENERATION` | 禁止写 `'gen8'` 或 `'gen3'` |
| Provider 默认值 | `DEFAULT_PROVIDER` | 禁止写 `\|\| 'deepseek'` 或 `\|\| 'moonshot'` |
| 模型默认值 | `DEFAULT_MODEL` | 禁止写 `'kimi-k2.5'` 或 `'deepseek-chat'` 作为 fallback |
| API 端点 | `MODEL_API_ENDPOINTS.*` | 禁止在 provider 中硬编码 URL |
| 超时值 | `*_TIMEOUTS.*` | 禁止写 `300000`、`30000` 等魔法数字 |
| 模型价格 | `MODEL_PRICING_PER_1M` | 禁止在多个文件中维护价格表 |
| 上下文窗口 | `CONTEXT_WINDOWS` | 禁止在多个文件中维护上下文窗口映射 |
| 视觉模型 | `ZHIPU_VISION_MODEL` | 禁止写 `'glm-4v-plus'` |
| Mermaid API | `MERMAID_INK_API` | 禁止在多个文件中定义 |
| API 版本 | `API_VERSIONS.ANTHROPIC` | 禁止写 `'2023-06-01'` |
| maxTokens 默认 | `MODEL_MAX_TOKENS.*` | 禁止散布 `8192`、`2048` |
| 目录名 | `CONFIG_DIR_NEW` (configPaths) | 禁止写 `'.code-agent'` 字面量 |

**新增 provider/模型/超时/价格时**，只在 `shared/constants.ts` 添加，然后引用。

**自检清单**（提交前）：
```bash
# 检查是否引入了新的硬编码
grep -rn "|| 'deepseek'" src/main/ --include="*.ts"
grep -rn "|| 'gen3'" src/main/ --include="*.ts"
grep -rn "'300000\|300_000'" src/main/ --include="*.ts"
```

---

## 安全模块 (v0.9+)

### 审计日志
```bash
cat ~/.code-agent/audit/$(date +%Y-%m-%d).jsonl | jq .
```

### 敏感信息自动检测
- API Keys、AWS 凭证、GitHub Tokens、私钥、数据库 URL

---

## Hooks 系统 (v0.9+)

支持 11 种事件：`PreToolUse`、`PostToolUse`、`SessionStart`、`SessionEnd`、`Stop` 等

配置位置：`.code-agent/hooks/hooks.json`（新）或 `.claude/settings.json`（旧，向后兼容）

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "./validate.sh" }]
    }]
  }
}
```

---

## Task DAG 调度系统 (v0.16+)

基于有向无环图的并行任务调度，支持：
- **自动并行检测**：分析依赖关系，最大化并行度
- **任务类型**：agent、shell、workflow、checkpoint、conditional
- **失败策略**：fail-fast、continue、retry-then-continue
- **可视化**：React Flow DAG 实时展示执行状态

```typescript
// 任务状态机
pending → ready → running → completed/failed/cancelled/skipped
```

---

## DI 容器 (v0.16+)

轻量级依赖注入，位于 `src/main/core/container.ts`：
- **Singleton**：全局单例
- **Factory**：每次创建新实例
- **Initializable/Disposable**：生命周期钩子

---

## v0.16.37 Web Search 智能过滤与提取 (2026-02-19)

对标 Claude 官方 Dynamic Filtering 能力，3 个优先级改进：

| 优先级 | 改进 | 文件 | 效果 |
|--------|------|------|------|
| P0 | webFetch 智能提取 | `webFetch.ts` + **新建** `htmlUtils.ts` | cheerio 解析 + modelCallback AI 提取，替代 50K 硬截断 |
| P1 | webSearch 域名过滤 | `webSearch.ts` | `allowed_domains` / `blocked_domains` 参数 |
| P2 | webSearch 搜索+提取一体化 | `webSearch.ts` | `auto_extract` 参数，搜索后自动 fetch+提取 |

### P0 降级链

`AI 提取（modelCallback）` → `smartTruncate（段落边界 8K）` → `fallbackHtmlToText（原始正则）`

- CLI 模式无 modelCallback，自动走 smartTruncate
- Token 节省：50K→8K（-54% 实测 MDN 页面）

### P1 域名过滤实现

| 搜索源 | 实现方式 |
|--------|---------|
| Brave | `site:` / `-site:` 拼入 query |
| EXA | 原生 `includeDomains` / `excludeDomains` |
| Perplexity | 域名约束拼入 message content |
| Cloud | `allowedDomains` / `blockedDomains` 透传 |

### P2 auto_extract

搜索完成后并行 fetch 前 N 个 URL（10s 超时）→ cheerio 解析 → modelCallback AI 提取（每 URL 3000 字符上限）。无 modelCallback 则跳过。

### 新增/改动文件

| 文件 | 操作 |
|------|------|
| `src/main/tools/network/htmlUtils.ts` | **新建** — cheerio 解析 + smartTruncate + buildExtractionPrompt + fallback |
| `src/main/tools/network/webFetch.ts` | 改写 — modelCallback AI 提取 + max_chars 参数 |
| `src/main/tools/network/webSearch.ts` | 扩展 — 域名过滤 + auto_extract + extract_count |

---

## v0.16.37 多 Agent 协作增强 (2026-02-19)

对标 Claude Code Team/TaskList/Shutdown/PlanApproval，新增 4 个增强模块（commit `cf7bfb9`）：

| 增强 | 新文件 | 改文件 | 行数 |
|------|--------|--------|------|
| E3 持久化团队 | `teamPersistence.ts`, `teamManager.ts` | configPaths, taskStore, teammateService, parallelAgentCoordinator | ~520 |
| E4 任务自管理 | — | coreAgents, spawnAgent | ~60 |
| E1 优雅关闭 | `shutdownProtocol.ts` | subagentExecutor, subagentPipeline, parallelAgentCoordinator, agentSwarm | ~200 |
| E2 审批流 | `planApproval.ts`, `planReview.ts` | subagentExecutor, agentSwarm, taskRouter, toolRegistry, multiagent/index | ~320 |

相关代码：
- `src/main/agent/teammate/teamPersistence.ts` — 原子写入 JSON 持久化
- `src/main/agent/teammate/teamManager.ts` — 团队生命周期 + gracefulShutdown handler
- `src/main/agent/shutdownProtocol.ts` — 4 阶段关闭 + `combineAbortSignals()`
- `src/main/agent/planApproval.ts` — 风险评估 + 串行审批队列
- `src/main/tools/multiagent/planReview.ts` — Coordinator 审批工具

## v0.16.37 工程能力提升 (2026-02-11)

Excel Agent Benchmark 最新: v19 189/200 (94.5%) | 最高: v14 190/200 (95%)
详细分值见 `excel-agent-benchmark/scores/scorecard.xlsx`

v19 改进要点（commit `8313b9d`）：
- **P7 输出结构验证**: agent 结束前用 pandas 读取输出 xlsx 结构，注入给模型核对需求
- **Workspace Diff**: 快照输出目录，通过文件增量替代纯正则路径提取，解决模糊描述遗漏
- **Few-shot 陷阱提醒**: read_xlsx 输出附加 3 条常见数据处理陷阱（去重 subset、阶梯累进、日期格式）
- P5 Nudge 在 force-execute 路径后增加输出文件检查，防止拦截绕过
- CLI 模式自动禁用 adaptiveRouter + 自动挂载 builtin skills（含 data-cleaning）

三项通用工程能力提升（v5 基线）：

### 1. 动态 maxTokens（截断自动恢复）

| 场景 | 机制 |
|------|------|
| 文本响应截断 | 自动翻倍 maxTokens（上限 8192），重试一次后恢复原值 |
| 工具调用截断 | 提升 maxTokens + 注入 `<truncation-recovery>` 续写提示 |
| 复杂任务预防 | AdaptiveRouter 在 `complexity.level === 'complex'` 时主动提升到 `MODEL_MAX_TOKENS.DEFAULT` |

模式与 `_contextOverflowRetried` 完全一致（`_truncationRetried` 标志）。

相关代码：
- `src/main/agent/agentLoop.ts` — 截断检测 + 重试逻辑
- `src/main/model/adaptiveRouter.ts` — 复杂任务 maxTokens 提升

### 2. 源数据锚定（防多轮幻觉）

借鉴 Claude Code 轻量标识符 + Codex 工具输出可引用模式。

**核心思路**：工具读取数据时提取"事实锚点"，compaction 时自动注入为 ground truth。

| 数据源 | 提取内容 | 存储类型 |
|--------|----------|----------|
| `read_xlsx` | schema + 首行样本 + 数值范围 | `DataFingerprint` |
| `bash`（统计输出） | mean/std/min/max 行、JSON 数值、行数 | `ToolFact` |
| `read_file`（CSV） | 列名 + 首行样本 + 行数 | `ToolFact` |
| `read_file`（JSON） | 数组长度 + 字段名 + 首条样本 | `ToolFact` |

**注入点**（两处，双保险）：
1. `autoCompressor.ts` — PreCompact hook 后追加到 `preservedContext`
2. `agentLoop.ts` — compaction recovery 注入 `block.content`

**注入格式**：
```
## 已验证的源数据
- data.xlsx Sheet1: 100行, 列=[日期,金额,类型]
  首行: {日期: 2024-01-01, 金额: 1234.5}
  金额范围: 100.0 ~ 9999.9

## 已验证的计算结果
- mean    1245.6, std    389.1

⚠️ 所有输出必须基于上述源数据和计算结果，禁止虚构数值
```

**防膨胀**：ToolFact LRU 上限 20 条，数值范围最多 3 列，样本最多 5 列。

相关代码：
- `src/main/tools/dataFingerprint.ts` — DataFingerprintStore + ToolFact + 提取函数
- `src/main/tools/network/readXlsx.ts` — xlsx 指纹记录
- `src/main/tools/shell/bash.ts` — bash 输出事实提取
- `src/main/tools/file/read.ts` — CSV/JSON schema 提取
- `src/main/context/autoCompressor.ts` — compaction 注入
- `src/main/agent/agentLoop.ts` — recovery 注入

### 3. 数据清洗 Skill

内置 `data-cleaning` skill，6 步系统性清洗检查清单：结构检查 → 重复值 → 缺失值 → 格式标准化 → 异常值检测 → 验证。

通过 skill 机制注入，不污染通用 prompt。

相关代码：
- `src/main/services/skills/builtinSkills.ts` — skill 定义
- `src/main/services/skills/skillRepositories.ts` — 关键词映射

---

## v0.16.11+ 新功能

### Checkpoint 系统
文件版本快照，支持任务级别回滚：
- `FileCheckpointService.ts` - 核心服务
- `file_checkpoints` 数据库表

### Nudge 机制
非侵入式任务完成引导：
- **P1**: 只读停止检测
- **P2**: Checkpoint 验证
- **P3**: 文件完成追踪

### ToolSearch 延迟加载
工具按需加载，减少启动时间和内存占用。

### 多渠道接入
- 飞书 Webhook 模式
- 可扩展的渠道架构

### Skills 系统
用户可定义技能，支持依赖检查。

### CLI 接口
命令行交互模式，支持数据库和会话持久化。

### 会话评测系统 v2 (v0.16.15+)

基于瑞士奶酪多层评测模型，分通用维度和垂直维度：

**通用维度（6 个，始终评测）**：

| 评审员 | 维度 | 权重 |
|--------|------|------|
| 任务分析师 | 任务完成度 | 25% |
| 事实核查员 | 事实准确性 | 20% |
| 沟通专家 | 回答质量 | 15% |
| 沟通专家 | 效率 | 10% |
| 经济使用分析师 | 经济使用 | 15% |
| 安全审计员 | 安全性 | 15% |

**垂直维度（4 个，按需触发，各 +15%）**：

| 评审员 | 维度 | 触发条件 |
|--------|------|----------|
| 代码审查员 | 代码质量 | 检测到代码块 |
| 数学验证员 | 数学准确性 | 检测到公式/计算 |
| 多模态分析师 | 多模态理解 | 检测到图片 |
| 复杂推理专家 | 复杂推理 | ≥3 个推理指标且非简单对话 |

**评测模型**：使用 Kimi K2.5（支持并发），通过 `KIMI_K25_API_KEY` 环境变量配置。

**参考来源**：
- OpenAI GDPval 真实任务评测
- Anthropic Economic Index 多维度分析
- GPQA / BIG-Bench Hard 复杂推理基准

### 实验室模块
- LLaMA Factory 微调教学
- NanoGPT 2.0 训练
- SFT & RLHF 对齐

### Subagent 优化
- 4 层架构重构
- 上下文注入机制
- Cowork 协作框架
- 复杂度分析与动态模式检测

### 性能优化
- 首次响应延迟减少 ~500ms
- Vite 代码分割
- 异步 I/O 优化
- Token 消耗优化

---

## v0.16.16+ 新功能

### 统一配置目录 (ADR-004)
将项目级扩展配置集中到 `.code-agent/` 目录：
```
.code-agent/
├── settings.json    # 用户个人设置
├── hooks/           # Hook 配置和脚本
├── skills/          # 项目级技能定义
├── agents/          # 自定义 Agent 配置
└── mcp.json         # MCP 服务器配置
```
向后兼容 `.claude/` 目录（优先读取新路径）。

相关代码：`src/main/config/configPaths.ts`

### 基础设施服务
新增 `src/main/services/infra/` 模块：

| 服务 | 说明 |
|------|------|
| `diskSpace.ts` | 磁盘空间监控，低空间预警 |
| `fileLogger.ts` | 结构化文件日志，自动轮转 |
| `gracefulShutdown.ts` | 优雅关闭，资源清理 |
| `timeoutController.ts` | 统一超时控制器 |

### 架构升级 Phase 1-5

**错误学习系统**：
- `errorLearning.ts` - 错误模式学习与避免
- `errorClassifier.ts` - 错误自动分类

**记忆增强**：
- `memoryDecay.ts` - 基于时间的记忆权重衰减
- `memoryService.ts` - 统一记忆服务

**动态提示系统**：
- `dynamicReminders.ts` - 上下文感知的动态提示
- `contextAwareReminders.ts` - 条件触发提醒
- `reminderRegistry.ts` - 提醒注册表
- `fewShotExamples.ts` - 任务类型示例管理

**计划执行监控**：
- `executionMonitor.ts` - 计划执行进度监控
- `feasibilityChecker.ts` - 任务可行性评估
- `planPersistence.ts` - 计划持久化存储

**恢复策略** (`src/main/agent/recovery/`)：
- `decompositionStrategy.ts` - 任务分解策略
- `degradationStrategy.ts` - 功能降级策略
- `learningStrategy.ts` - 学习型恢复策略

### 数据安全增强
- `atomicWrite.ts` - 文件写入原子性保证
- `withTimeout.ts` - 带超时的 IPC 调用
- 数据库事务并发控制（乐观锁）

### 用户体验优化
- **AlertBanner** - 警告横幅组件
- **CommandPalette** - 命令面板（Cmd+K）
- **ErrorDisplay** - 统一错误显示
- **NetworkStatus** - 网络状态实时监控
- **ExportModal** - 会话导出模态框
- **高对比度主题** - 无障碍支持
- **键盘快捷键增强** - 全局快捷键系统

### 模型能力增强
- **Moonshot Provider** - Kimi K2.5 SSE 流式支持
- **智谱限流处理** - 自动重试和退避
- **可中断 API 调用** - 所有 provider 支持 AbortController

### Gen8 执行模式
三种模式自主判断：
1. **直接执行** - 简单任务，立即行动
2. **分步执行** - 中等任务，分解后执行
3. **规划执行** - 复杂任务，先规划后执行

模型会根据任务复杂度自动选择模式。

相关代码：`src/main/generation/prompts/base/gen8.ts`

### Subagent 模型分工
| 任务类型 | 模型 | 原因 |
|----------|------|------|
| 简单任务（explore、bash）| GLM-4.7-Flash | 免费、快速 |
| 规划任务（plan、review）| GLM-5 | 0ki 包年 Coding 套餐 |
| 复杂执行（coder、refactorer）| DeepSeek V3 | 代码能力强 |

支持环境变量覆盖模型配置。

### Bug 修复
- AgentLoop 核心算法 Bug 修复
- DAG 调度器竞态条件修复（互斥锁保护）
- CLI native 模块延迟加载
- Token 优化器边界条件处理
- 消息转换器空值检查

### E2E 测试增强
新增 L5/L6 高难度测试用例：
- `M06-auth-rbac.ts` - RBAC 权限系统实现
- `M07-realtime-collab.ts` - 实时协作功能

---

## v0.16.19 新功能 (2026-02-06)

### E1-E6 六大工程层改进

横跨所有场景的基础能力提升，各自独立可用。

#### E1: 引用溯源框架 (Citation)

工具执行后自动提取引用源（文件行号、URL、单元格等），附加到消息中，renderer 展示可点击引用标签。

| 引用类型 | 提取源 | 样式 |
|----------|--------|------|
| `file` | read_file, grep, glob | 蓝色 📄 |
| `url` | web_fetch, web_search | 青色 🔗 |
| `cell` | read_xlsx | 绿色 📊 |
| `query` | web_search | 琥珀色 🔍 |
| `memory` | memory_search | 紫色 🧠 |

相关代码：
- `src/main/services/citation/citationExtractor.ts` - 从工具结果按类型提取引用
- `src/main/services/citation/citationService.ts` - 会话级引用收集器
- `src/renderer/components/citations/CitationList.tsx` - 可点击引用列表 + CitationSummary
- `src/shared/types/citation.ts` - 共享类型定义

#### E2: 细粒度确认门控 (ConfirmationGate)

写操作前展示 before/after 预览 + 确认对话框，策略可配置。

| 策略 | 行为 |
|------|------|
| `always_ask` | 每次都弹确认 |
| `always_approve` | 自动批准 |
| `ask_if_dangerous` | 仅高风险操作确认 |
| `session_approve` | 同类操作只确认一次 |

相关代码：
- `src/main/agent/confirmationGate.ts` - 策略判定 + 预览构建
- `src/renderer/components/PermissionDialog/RequestDetails.tsx` - 扩展 diff 预览
- `src/shared/types/confirmation.ts` - 确认类型定义

#### E3: 变更追踪 & Visual Diff (DiffTracker)

每次文件修改产生结构化 unified diff，会话级持久化存储，可按 session/message/file 查询。

相关代码：
- `src/main/services/diff/diffTracker.ts` - diff 计算 + 存储（复用 `diff` 库）
- `src/main/ipc/diff.ipc.ts` - IPC handlers
- `src/renderer/components/DiffPanel/index.tsx` - 会话级变更追踪面板
- `src/shared/types/diff.ts` - FileDiff, DiffSummary 类型

#### E4: 运行时模型热切换 (ModelSessionState)

用户在对话中途通过 UI 切换模型，下一轮生效，不中断当前轮。

相关代码：
- `src/main/session/modelSessionState.ts` - Session override 管理
- `src/renderer/components/StatusBar/ModelSwitcher.tsx` - 模型选择下拉框
- `src/main/ipc/session.ipc.ts` - switchModel/getModelOverride IPC

#### E5: 文档上下文抽象层 (DocumentContext)

统一的结构化文档理解接口，5 种解析器，与压缩器集成。每个 section 带 `importance` 权重（0-1），压缩时优先保留高权重内容。

| 解析器 | 格式 | 分段策略 |
|--------|------|----------|
| CodeParser | .ts/.js/.py/.go 等 | 函数/类/import 分段，export 权重高 |
| MarkdownParser | .md | 按 heading 层级分段，h1 权重高 |
| ExcelParser | .csv/.xlsx | header 权重 0.9，数据 50 行一块 |
| DocxParser | .docx | 段落分段，标题权重高 |
| PdfParser | .pdf | 空行分段，等权重 |

相关代码：
- `src/main/context/documentContext/` - 类型 + 解析器注册表 + ParsedDocumentImpl
- `src/main/context/autoCompressor.ts` - 集成 importance-aware 压缩

#### E6: 外部数据安全校验 (InputSanitizer)

外部数据（web_fetch/MCP/read_xlsx 等）进入 agent 上下文前，检测 prompt injection。20+ 正则模式，4 种检测类别。

| 检测类别 | 示例 |
|----------|------|
| `instruction_override` | "ignore previous instructions", "[SYSTEM]" |
| `jailbreak_attempt` | "act as DAN", "developer mode enabled" |
| `data_exfiltration` | "send data to URL", "reveal system prompt" |
| `prompt_injection` | "IMPORTANT: ignore", XML tag role switching |

三种模式：`strict`（低阈值阻断）、`moderate`（默认）、`permissive`（仅警告）

相关代码：
- `src/main/security/inputSanitizer.ts` - 核心检测器
- `src/main/security/patterns/injectionPatterns.ts` - 20+ 检测正则
- `src/main/agent/agentLoop.ts` - 外部工具结果过滤集成

### PPT 生成系统模块化重构

将 `pptGenerate.ts`（1841 行）拆分为 9 个模块，借鉴 Claude in PowerPoint 的声明式设计。

详见 [docs/guides/ppt-capability.md](docs/guides/ppt-capability.md)

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| 文件数 | 1 | 9 + 2 tests |
| 主题数 | 8 | 9（+apple-dark） |
| 图表 | mermaid PNG（不可编辑） | 原生 addChart（可编辑） |
| 布局方式 | 命令式坐标 | Slide Master 声明式 |
| 测试 | 无 | 137 个用例 |

相关代码：`src/main/tools/network/ppt/`

### Agent 协作增强

- **TeammateService** - Agent 间通信（coordinate/handoff/query/broadcast）
- **SwarmMonitor** - 实时监控面板（Agent 状态/统计/Token 用量）
- **AgentTeamPanel** - Agent 团队协作视图
- **Orchestrator Prompt** - 协调者身份和工作流定义

相关代码：
- `src/main/agent/teammate/` - TeammateService 通信服务
- `src/renderer/components/features/swarm/` - SwarmMonitor 监控
- `src/renderer/components/features/agentTeam/` - 团队面板
- `src/main/generation/prompts/base/orchestrator.ts` - 协调者 prompt

### 测试覆盖

| 测试文件 | 测试数 | 覆盖模块 |
|----------|--------|---------|
| `inputSanitizer.test.ts` | 22 | E6 安全校验 |
| `gen5.test.ts` | 21 | Gen5 记忆系统（v0.16.22 修复 4 个 mock 缺陷） |
| `documentParser.test.ts` | 19 | E5 文档上下文 |
| `confirmationGate.test.ts` | 15 | E2 确认门控 |
| `diffTracker.test.ts` | 13 | E3 变更追踪 |
| `citationExtractor.test.ts` | 9 | E1 引用溯源 |
| `ppt.test.mjs` | 55 | PPT 基础 |
| `ppt-extended.test.mjs` | 82 | PPT 扩展 |
| `teammate.test.ts` | 12 | Agent 协作 |
| **总计** | **248** | |

---

## v0.16.22 成本优化与健壮性增强 (2026-02-08)

### Electron 33 → 38 升级

| 组件 | v0.16.21 | v0.16.22 |
|------|----------|----------|
| Electron | 33 (Chromium 130, V8 13.0, Node 20.18) | **38** (Chromium 140, V8 14.0, Node 22.16) |

**升级天花板**：Electron 39+ 的 V8 14.2 移除了 `Object::GetIsolate()` API，`isolated-vm` 无法编译。38 是当前最高兼容版本。

### 7 项 CodePilot 对标改进

#### 1. System Prompt 精简（再降 ~20%）

精简 gen8.ts tool table 和 identity.ts TOOL_DISCIPLINE。

相关代码：
- `src/main/generation/prompts/base/gen8.ts` — 合并为 2 列 tool table
- `src/main/generation/prompts/identity.ts` — TOOL_DISCIPLINE 压缩为 3 行

#### 2. 激进消息历史裁剪

更早触发压缩，更激进地截断旧消息和工具结果。

相关代码：
- `src/main/context/autoCompressor.ts` — `warningThreshold` 0.7→0.6，新增 `aggressiveTruncate()`
- `src/main/context/tokenOptimizer.ts` — 压缩阈值 500→300，目标 300→200 tokens

#### 3. 推理请求去重缓存

非流式请求的 LRU 缓存，key = md5(last 3 messages + provider + model)，只缓存 text 响应。

相关代码：`src/main/model/inferenceCache.ts`（新文件）

#### 4. 自适应模型路由

简单任务（score < 30）自动路由到免费模型 zhipu/glm-4.7-flash，失败自动 fallback。

| 复杂度 | 分数 | 路由 |
|--------|------|------|
| simple | < 30 | zhipu/glm-4.7-flash（免费）|
| moderate | 30-60 | 保持默认 |
| complex | 60+ | 保持默认 |

相关代码：`src/main/model/adaptiveRouter.ts`（新文件）

#### 5. 错误分类与自动恢复

6 种错误模式的自动恢复引擎。

| 错误类型 | 恢复动作 |
|---------|---------|
| RATE_LIMIT (429) | 指数退避自动重试 |
| PERMISSION (401) | 引导打开设置 |
| CONTEXT_LENGTH | 自动压缩 |
| TIMEOUT | 切换 provider |
| CONNECTION | 自动重试 |
| MODEL_UNAVAILABLE | 切换 provider |

相关代码：
- `src/main/errors/recoveryEngine.ts`（新文件）
- `src/main/ipc/error.ipc.ts`（新文件）
- `src/renderer/hooks/useErrorRecovery.ts`（新文件）

#### 6. 工具 DAG 调度

基于文件依赖的 DAG 调度器，Kahn 算法拓扑排序，分层并行执行。

| 依赖类型 | 规则 |
|---------|------|
| WAR | `edit_file(X)` 依赖前序 `read_file(X)` |
| WAW | 并发 `write_file(X)` 串行化 |
| Bash | 提取 `>` / `>>` 重定向写路径 |

快速路径：无依赖时直接走现有 parallelStrategy，零开销。

相关代码：`src/main/agent/toolExecution/dagScheduler.ts`（新文件）

#### 7. 实时成本流

SSE 流式响应期间每 500ms 估算 token 数，StatusBar 实时更新（脉冲动画 + ▲ 指示器）。

相关代码：
- `src/main/model/providers/moonshot.ts` — 流式 token 估算
- `src/main/model/providers/zhipu.ts` — 流式 token 估算
- `src/renderer/stores/statusStore.ts` — `isStreaming` 状态
- `src/renderer/components/StatusBar/TokenUsage.tsx` — 脉冲动画
- `src/renderer/components/StatusBar/CostDisplay.tsx` — 脉冲动画

### 新增文件清单

| 文件 | 行数 | 功能 |
|------|------|------|
| `src/main/model/inferenceCache.ts` | ~115 | 请求去重 LRU 缓存 |
| `src/main/model/adaptiveRouter.ts` | ~122 | 自适应模型路由 |
| `src/main/errors/recoveryEngine.ts` | ~250 | 错误自动恢复引擎 |
| `src/main/ipc/error.ipc.ts` | ~40 | 错误恢复 IPC |
| `src/main/agent/toolExecution/dagScheduler.ts` | ~218 | 工具 DAG 调度器 |
| `src/renderer/hooks/useErrorRecovery.ts` | ~60 | 错误恢复 React Hook |

### 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/main/generation/prompts/base/gen8.ts` | 精简 tool table (~20%) |
| `src/main/generation/prompts/identity.ts` | 压缩 TOOL_DISCIPLINE |
| `src/main/context/autoCompressor.ts` | 更激进裁剪阈值 (0.7→0.6) |
| `src/main/context/tokenOptimizer.ts` | 降低压缩阈值 (500→300) |
| `src/main/model/modelRouter.ts` | 集成缓存 + 自适应路由 |
| `src/main/model/types.ts` | StreamChunk 扩展 `token_estimate` 类型 |
| `src/main/model/providers/moonshot.ts` | 流式 token 估算 |
| `src/main/model/providers/zhipu.ts` | 流式 token 估算 |
| `src/shared/ipc.ts` | 新增 ERROR domain |
| `src/main/agent/toolExecution/index.ts` | 导出 DAG 调度器 |
| `src/renderer/stores/statusStore.ts` | 新增 `isStreaming` 状态 |
| `src/renderer/components/StatusBar/TokenUsage.tsx` | 流式脉冲动画 |
| `src/renderer/components/StatusBar/CostDisplay.tsx` | 流式脉冲动画 |
| `src/renderer/components/StatusBar/index.tsx` | 传递 `isStreaming` prop |
| `src/renderer/components/StatusBar/types.ts` | 新增 `isStreaming` prop |
| `tests/generations/gen5.test.ts` | 修复 VectorStore mock 缺少 `save()` |
| `package.json` | Electron ^33.0.0 → ^38.8.0 |

---

## v0.16.22 综合增强 (2026-02-08)

本次版本一次性合并 9 个 PR（#39, #48, #49, #50, #51, #54, #55, #56, #57），涵盖工具、Agent 架构、健壮性、会话体验四大方面。

### 新增工具

| 工具 | PR | 说明 |
|------|-----|------|
| `pdf_compress` | #57 | PDF 压缩工具，支持质量/分辨率/灰度参数 |
| `xlwings Excel` | #49 | Excel 自动化工具，读写 xlsx/csv |

相关代码：
- `src/main/tools/network/pdfCompress.ts`
- `src/main/tools/network/xlwings/`

### PPT 生成模块化重构 (PR #51)

将 `pptGenerate.ts`（1841 行）拆分为 9 个模块。详见 [docs/guides/ppt-capability.md](docs/guides/ppt-capability.md)

### Agent 架构增强 (PR #50)

- **增强型 Compaction** — CompactionBlock 可审计摘要 + 自定义 instructions
- **Agent Teams** — P2P 通信 + Delegate 模式 + Plan 审批
- **Adaptive Thinking** — 客户端思考引导（effort: low/medium/high/max）

### 会话体验 (PR #55)

- **智能会话标题** — 基于首轮对话自动生成有意义的标题

### Bug 修复

| PR | 修复内容 |
|-----|---------|
| #39 | 流程可视化从未显示 + 评测系统优化 |
| #48 | P2 Checkpoint nudge 区分分析型和修改型任务 |

---

## v0.16.21 健壮性增强 (2026-02-08)

### h2A 实时转向机制

替代旧的 interrupt-and-rebuild 模式，采用 Claude Code 风格的 h2A 消息注入：

| 能力 | 说明 |
|------|------|
| `steer()` | 运行中注入用户消息，不销毁 loop，保留所有中间状态 |
| API 流中断 | AbortController signal 传递到 modelRouter.inference()，可立即终止流 |
| 消息排队 | Orchestrator 层消息队列，快速连续输入不互相覆盖 |
| 状态保持 | CircuitBreaker、AntiPatternDetector、工具结果等全部保留 |

相关代码：
- `src/main/agent/agentLoop.ts` — steer() 方法 + pendingSteerMessage 队列
- `src/main/agent/agentOrchestrator.ts` — interruptAndContinue() 重写为 steer 模式
- `src/main/agent/taskList/` — TaskListManager 模块 + IPC handlers

### Compaction 恢复上下文 (P0)

上下文压缩后自动注入最近读取的文件和待处理 TODO/任务到摘要中，保留工作上下文：

- `FileReadTracker` 提供最近读取文件列表
- TODO/任务状态注入 compaction summary
- 模型在压缩后不会"遗忘"正在处理的文件

相关代码：
- `src/main/agent/agentLoop.ts` — compaction recovery 注入逻辑
- `src/main/tools/fileReadTracker.ts` — getRecentlyReadFiles()

### Edit 文件代码片段 (P1)

edit_file 成功后返回 4 行上下文代码，模型可直接验证编辑正确性，无需重新 read_file。

相关代码：`src/main/tools/file/edit.ts`

### Context Overflow 自动恢复 (P1)

遇到 `ContextLengthExceededError` 时自动压缩并以 0.7x maxTokens 重试，而非直接失败。

相关代码：`src/main/agent/agentLoop.ts`

### 动态 Bash 描述 (P2)

通过 GLM-4.7-Flash（免费）为 bash 命令生成 5-10 词描述，与命令执行并行不增加延迟，LRU 缓存。

相关代码：
- `src/main/tools/shell/dynamicDescription.ts` — generateBashDescription()
- `src/main/tools/shell/bash.ts` — 并行调用集成

---

## v0.16.20 对标 Claude Code 2026 (2026-02-06)

### Phase 1: 增强型 Compaction 系统

模拟 Claude 的 `context_management.edits` 行为：

| 能力 | 说明 |
|------|------|
| `CompactionBlock` | 可审计摘要块，保留在消息历史中 |
| `triggerTokens` | 绝对 token 阈值触发（默认 100000），取代百分比 |
| `pauseAfterCompaction` | 压缩后暂停，通过 PreCompact Hook 注入保留内容 |
| `shouldWrapUp()` | 基于 compaction 次数 × 阈值判断是否超出总预算 |
| `instructions` | 自定义摘要指令，默认 Claude 风格（状态/下一步/关键决策） |
| UI | 折叠式摘要卡片，显示压缩消息数和节省 token 数 |

相关代码：
- `src/main/context/autoCompressor.ts` — compactToBlock/shouldWrapUp/getCompactionCount
- `src/main/context/compactModel.ts` — 增强摘要 + instructions 参数
- `src/main/agent/agentLoop.ts` — 主循环集成 compaction 检查
- `src/shared/types/message.ts` — CompactionBlock 类型

### Phase 2: Agent Teams 集成

将 TeammateService P2P 通信集成到 Swarm 执行流：

| 能力 | 说明 |
|------|------|
| P2P 通信 | Agent 间可辩论、挑战、分享发现（broadcast/query/respond） |
| 用户交互 | 通过 AgentTeamPanel 直接与任意 agent 对话 |
| Delegate 模式 | Orchestrator 只分配不执行，强制 auto-agent |
| Plan 审批 | teammate 先出 plan，lead 审批后才执行 |
| 任务分配概览 | 展示各 agent 状态、lastReport、toolCalls |

相关代码：
- `src/main/agent/teammate/teammateService.ts` — subscribeToAgent/onUserMessage/getConversation
- `src/main/agent/agentOrchestrator.ts` — delegateMode/requirePlanApproval
- `src/main/agent/hybrid/agentSwarm.ts` — enablePeerCommunication + broadcast
- `src/renderer/components/features/agentTeam/` — AgentTeamPanel UI
- `src/main/ipc/swarm.ipc.ts` — 3 个新 IPC 通道
- `src/shared/types/swarm.ts` — 4 个新事件类型

### Phase 3: 客户端 Adaptive Thinking 模拟

通过 prompt 级思考引导模拟 Claude 的 adaptive thinking：

| 能力 | 说明 |
|------|------|
| `InterleavedThinkingManager` | shouldThink + generateThinkingPrompt |
| Effort 级别 | low（仅初始规划）/ medium（错误恢复时）/ high（每次 tool call 后）/ max |
| 自动映射 | taskComplexityAnalyzer → effort（simple→low, moderate→medium, complex→high） |
| DeepSeek 映射 | reasoning_content → thinking block |
| UI | 可折叠思考卡片 + effort 级别徽章（Zap 图标，颜色编码） |

相关代码：
- `src/main/agent/agentLoop.ts` — InterleavedThinkingManager + effortLevel
- `src/main/agent/loopTypes.ts` — ModelResponse.thinking
- `src/main/model/providers/deepseek.ts` — reasoning → thinking 映射
- `src/shared/types/agent.ts` — EffortLevel 类型
- `src/renderer/components/features/chat/MessageBubble/AssistantMessage.tsx` — 思考 UI

---

## v0.16.18 新功能 (2026-02-03)

### Prompt 重构 - Token 减少 81%

对 prompt 系统进行 Claude Code 风格重构，大幅减少 token 消耗：

| 代际 | 优化前 | 优化后 | 减少 |
|------|--------|--------|------|
| Gen8 | 7992 tokens | 1485 tokens | **-81%** |
| Gen3 | ~5000 tokens | 1421 tokens | **-72%** |
| Gen1 | ~3000 tokens | 990 tokens | **-67%** |

**主要变更**：
- 新增 `identity.ts` 替代 `constitution/` 目录（6 文件 → 1 文件）
- 精简 `gen8.ts`，内联关键规则
- 精简 `bash.ts`，嵌入 Git 工作流
- 精简 `edit.ts`，移除冗余说明
- 移除静态规则加载，改为内联 IMPORTANT
- 删除各 genX.ts 中的向后兼容别名（`GENx_BASE_PROMPT`）

相关代码：`src/main/generation/prompts/`

### 3 层混合 Agent 架构

重构 Agent 系统为 3 层混合架构（详见 CLAUDE.md 的"混合式多 Agent 架构"章节）：

**核心变更**：
- 新增 `hybrid/` 模块实现 3 层架构
- `agentDefinition.ts` 重构为适配层
- 移除 17 个旧 Agent 定义，简化为 4 个核心角色
- `subagentPipeline` 支持扁平化字段向后兼容

**模型层级配置**：
| 模型层级 | 模型 | 适用角色 |
|----------|------|----------|
| fast | GLM-4.7-Flash | explore, bash |
| balanced | GLM-5 | plan, reviewer（0ki 包年 Coding 套餐） |
| powerful | Kimi K2.5 | coder, refactorer |

相关代码：`src/main/agent/hybrid/`

### 工具纪律增强

**问题**：
- 模型把参数写进 file_path（如 `"file.ts offset=10"`）
- 同一文件重复读取多次
- edit_file 失败后无限重试相同参数

**解决方案**：
- P0: 工具描述增加 ✅/❌ 示例，明确参数格式
- P0: edit_file 增加重试策略指导（失败 2 次换 write_file）
- P1: AntiPatternDetector 增加策略切换建议
- P2: 重复调用时返回缓存提示

**测试结果**：M06 从第 5 步卡住 → 完成全部 10 步

相关代码：
- `src/main/generation/prompts/tools/bash.ts`
- `src/main/generation/prompts/tools/edit.ts`
- `src/main/agent/antiPattern/detector.ts`

### 动态工具调用上限

新增 `calculateToolCallMax` 函数，根据任务复杂度自动计算工具调用上限：

| 复杂度 | 基础上限 | 每步额外 |
|--------|----------|----------|
| L1 | 20 | +8 |
| L2 | 35 | +8 |
| L3 | 50 | +8 |
| L4 | 70 | +8 |
| L5 | 100 | +8 |
| L6 | 150 | +8 |

**示例**：M06（L5，10 步）= 100 + (10 × 8) = 180 次（原硬编码 80 次导致失败）

相关代码：`src/cli/commands/chat.ts`

---

## 快速参考

### 打包发布清单
```bash
cd /Users/linchen/Downloads/ai/code-agent
# 1. 合并代码
git merge <branch>
# 2. 检查 + 更新版本
npm run typecheck
npm version patch --no-git-tag-version
git add package.json && git commit -m "chore: bump version" && git push
# 3. 构建
npm run build
# 4. ⚠️ 重编译原生模块（必须在 dist:mac 之前！）
npm run rebuild-native
# 5. 打包
rm -rf release/ && npm run dist:mac
# 6. 安装后同步 .env
cp .env "/Applications/Code Agent.app/Contents/Resources/.env"
```

**⚠️ 第 4 步不可跳过**：`postinstall` 钩子只在 `npm install` 时触发。如果之后执行过 `npm rebuild`（CLI 测试等）或手动改过 `node_modules/`，原生模块会被系统 Node.js 版本覆盖。打包前必须显式 `npm run rebuild-native`。

### 本地数据库
```
~/Library/Application Support/code-agent/code-agent.db
```

### 问题排查
详见 [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md)

---

## 错题本

### 2026-02-02: E2E 测试超时分析错误

**错误做法**：
- 看到测试超时 10 分钟，武断判断"模型思考太久"
- 建议增加催促机制或缩短思考时间

**正确分析方法**：
1. 先检查日志看这 10 分钟**实际产出了什么**（plan 文档？工具调用？还是 0 输出？）
2. 区分是"模型在生成内容但慢"还是"API 调用完全卡住无响应"
3. 检查 API 超时配置是否合理

**本案实际原因**：
- G07/R06 超时：zhipu provider 没有配置 timeout，API 调用卡死无响应
- M05 失败：子 agent 返回后，模型幻觉了错误路径 `/Users/codeagent/demo/...`

**经验教训**：
- 分析问题要看**具体日志和数据**，不能只看表面现象
- "超时"可能是多种原因：网络问题、API 限流、模型推理慢、配置错误

### 2026-02-02: 模型路径幻觉问题

**问题**：子 agent 返回结果后，主 agent 用错误路径读取文件

**不完整的解决方案**：只在 prompt 里声明工作目录

**更健壮的方案**（参考 [LangChain Context Engineering](https://docs.langchain.com/oss/python/langchain/context-engineering)）：
1. 子 agent 返回**绝对路径**，不依赖主 agent 拼接
2. 工具层做**路径验证**：文件存在性检查、路径前缀校验
3. 把 LLM 输出当作**不可信输入**，验证后再执行

### 2026-02-02: API 超时配置

**大厂参考**（[Claude Code Router](https://lgallardo.com/2025/08/20/claude-code-router-openrouter-beyond-anthropic/)）：
- Claude Code Router: `API_TIMEOUT_MS: 600000` (10 分钟)
- Anthropic 默认: 1 分钟（大 payload 会 504）

**建议**：
- 超时时间应**可配置**，不同任务复杂度需要不同超时
- 流式响应场景：设置首 token 超时 + 总超时
- 添加**心跳检测**：长时间无 token 返回时主动超时

### 2026-02-02: 模型名称不要乱猜

**错误做法**：
- 不查文档，凭印象猜测模型名称：`codegeex-4`、`glm-4.7-flash`、`glm-4.7`
- 结果：API 报错，浪费时间

**正确做法**：
1. 查阅 [docs/guides/model-config.md](docs/guides/model-config.md) 获取正确的模型名称
2. 查看 provider 的官方文档确认模型 ID
3. 如需切换模型，确保环境变量也同步更新

**本次正确配置**：
- 评测模型：`kimi-k2.5` (provider: `moonshot`)
- API 地址：`https://cn.haioi.net/v1`
- 环境变量：`KIMI_K25_API_KEY`

### 2026-02-02: 原生模块必须用 Electron headers 重编译 ✅ 已自动化

**症状**：
```
Error: The module was compiled against a different Node.js version
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 130.
```

**原因**：原生模块（isolated-vm, better-sqlite3, keytar）使用系统 Node.js 编译，与 Electron 内置的 Node.js 版本不匹配。

**已实施的自动化方案**：
- `postinstall` 钩子：每次 `npm install` 后自动执行 `rebuild-native.sh`
- 脚本自动读取当前 Electron 版本，无需手动指定 `--target`
- 手动触发：`npm run rebuild-native`

### 2026-02-02: 评测维度显示问题

**问题**：
1. 维度名称显示英文（`factualAccuracy`、`economicUsage`）
2. 简单问候"你好"触发了"复杂推理"维度

**原因**：
1. `DIMENSION_NAMES` 映射缺少新增维度
2. 复杂推理检测阈值太低（任何推理关键词都触发）

**修复**：
1. 在 `sessionAnalytics.ts` 添加完整的维度枚举和映射
2. 提高复杂推理触发阈值：需要 ≥3 个匹配，且排除简单对话（≤2轮且<500字符）

### 2026-02-02: 第三方代理的 SSE 格式问题

**问题**：Kimi K2.5 第三方代理返回非标准 SSE 格式

```
: OPENROUTER PROCESSING

data: {"id":"gen-xxx","choices":[...]}
```

**错误做法**：使用 axios/electronFetch 处理流式响应（axios 不支持真正的 SSE 流式处理）

**正确做法**：使用原生 `https` 模块处理 SSE：
1. 按 `\n` 分割 buffer
2. 忽略以 `:` 开头的注释行
3. 只处理 `data:` 开头的行
4. 处理 `[DONE]` 结束标记

**相关代码**：`src/main/model/providers/moonshot.ts`

### 2026-02-02: CLI vs Electron 原生模块编译

**问题**：CLI 和 Electron 需要不同版本的原生模块

| 运行环境 | Node ABI 版本 | 编译方式 |
|----------|---------------|----------|
| CLI (node dist/cli/index.cjs) | NODE_MODULE_VERSION 127 | `npm rebuild --build-from-source` |
| Electron App | NODE_MODULE_VERSION 130 | `npm run rebuild-native` (使用 Electron headers) |

**注意**：
- `npm run rebuild-native` 是为 Electron 编译
- 如果要测试 CLI，需要先用 `npm rebuild` 为 Node.js 重编译
- 打包前必须运行 `npm run rebuild-native`

### 2026-02-02: L4 复杂任务 + Kimi K2.5 的工具调用问题 ✅ 已修复

**现象**：L4 测试大部分在 6-10 秒内失败，`tool-used: 0/7`

**根因**：
- Gen8 的 prompt 只列出了工具，没有**强调必须使用工具**
- 缺少**工具选择决策树**（什么情况用什么工具）
- 模型倾向于直接给文本建议而不调用工具

**修复方案**（已实施 commit `110c97d`）：

1. **增强 Gen8 Prompt**（`src/main/generation/prompts/base/gen8.ts`）：
   - 添加工具选择决策树表格
   - 明确"禁止盲编辑、先探索后执行"等原则
   - 添加正确/错误做法示例
   - **关键语句**："你必须使用工具来执行任务，不能只输出文本建议！"

2. **调整子代理模型配置**（`src/main/agent/agentDefinition.ts`）：
   - 简单任务（explore、bash）→ GLM-4.7-Flash（免费快）
   - 规划任务（plan、review）→ GLM-5（0ki 包年 Coding 套餐）
   - 复杂执行（coder、refactorer、debugger）→ DeepSeek V3（代码能力强）
   - 支持环境变量覆盖

**验证效果**（M04 测试）：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 运行时间 | 9.9 秒 | 7.5 分钟 |
| agent-dispatched | ❌ | ✅ |
| tool-used | ❌ | ✅ |
| tool-count-min | ❌ | ✅ |

**结论**：过程验证 6/6 全通过，证明修复有效。结果验证部分失败是因为任务复杂需要更多时间。

### 2026-02-10: cn.haioi.net 代理并发上限 = 2 ✅ 已修复

**现象**：v4 评测全部 10 个 case 出现 TLS 断开，得分从 v3 的 71% 跌至 61%

**错误消息**：`Client network socket disconnected before secure TLS connection was established` (code=ECONNRESET)

**根因链**：
1. cn.haioi.net（Moonshot 第三方代理）在 ≥4 并发 SSE 连接时主动断开 TLS
2. `retryStrategy.ts` 只检查 `err.message` 不检查 `err.code`，TLS 错误不被识别为瞬态错误
3. Moonshot provider 无并发限流器（智谱有 `ZhipuRateLimiter` 限 3 并发）
4. `agentLoop.ts` 网络错误直接 throw 不重试

**并发安全阈值**：

| 并发数 | 表现 |
|--------|------|
| 1-2 | ✅ 稳定 |
| 3 | ⚠️ 偶发 TLS 断开 |
| 4+ | ❌ 频繁断开 |

**修复 (4 项)**：
1. `retryStrategy.ts`: 新增 `TRANSIENT_CODES` 数组 + `isTransientError` 接受 `errCode` 参数
2. `agentLoop.ts`: 网络错误在 loop 层兜底重试 1 次（2s 延迟）
3. `moonshot.ts`: 新增 `MoonshotRateLimiter`（默认 maxConcurrent=2）
4. `detector.ts`: 修复 `Ran:` 正则 `s` flag 导致 markdown 混入 bash 命令

**环境变量**：`MOONSHOT_MAX_CONCURRENT`（默认 2，可覆盖）

**Provider 并发限制汇总**：

| Provider | 限流器 | 默认并发 | 环境变量 |
|----------|--------|---------|----------|
| Moonshot (cn.haioi.net) | `MoonshotRateLimiter` | 2 | `MOONSHOT_MAX_CONCURRENT` |
| 智谱 (0ki 中转) | `ZhipuRateLimiter` | 4 | `ZHIPU_MAX_CONCURRENT` |
| DeepSeek | 无（官方 API 较稳定）| - | - |

**相关代码**：
- `src/main/model/providers/moonshot.ts` — 限流器 + keepAlive=false Agent
- `src/main/model/providers/retryStrategy.ts` — 瞬态错误检测 + 重试
- `src/main/agent/agentLoop.ts` — 网络错误兜底重试
- `src/main/agent/antiPattern/detector.ts` — force tool call 正则修复

### 2026-02-03: 模型参数格式混淆

**问题**：模型把多个参数写进单个字段
```typescript
// 错误示例
read_file({ file_path: "src/app.ts offset=10 limit=50" })

// 正确格式
read_file({ file_path: "src/app.ts", offset: 10, limit: 50 })
```

**原因**：工具描述缺少明确的参数格式示例

**解决方案**：
1. 工具描述增加 ✅ 正确 / ❌ 错误示例
2. 明确参数是独立字段，不能合并到路径中

**相关代码**：`src/main/generation/prompts/tools/*.ts`

### 2026-02-03: edit_file 失败后的重试策略

**问题**：edit_file 失败后无限重试相同参数

**错误做法**：模型反复用相同的 old_string 尝试 edit_file

**正确策略**：
1. 第 1 次失败：调整 old_string（增加上下文、检查空格/换行）
2. 第 2 次失败：改用 write_file 重写整个文件
3. 切换策略时通知用户原因

**相关代码**：
- `src/main/generation/prompts/tools/edit.ts`
- `src/main/agent/antiPattern/detector.ts`

### 2026-02-03: 硬编码工具调用上限导致复杂任务失败

**问题**：M06（L5 复杂度，10 步）需要 85 次工具调用，硬编码上限 80 次导致失败

**错误做法**：所有任务使用相同的工具调用上限

**正确做法**：
- 根据任务复杂度动态计算上限
- 公式：`基础上限(复杂度) + 步骤数 × 8`
- L1=20, L2=35, L3=50, L4=70, L5=100, L6=150

**相关代码**：`src/cli/commands/chat.ts` - `calculateToolCallMax()`

### 2026-02-08: Electron 40 升级失败 — isolated-vm V8 API 不兼容

**症状**: `npm install` 后 `rebuild-native` 编译 `isolated-vm` 失败

**根因**: Electron 40 使用 V8 14.4，两个 C++ API 被移除/改名：
- `v8::Object::GetIsolate()` → 已移除，替代：`v8::Isolate::GetCurrent()`
- `v8::Object::GetPrototype()` → 改名为 `GetPrototypeV2()`

**影响范围**: `isolated-vm` 的 `src/isolate/class_handle.h:231-233` 使用了这两个 API

**测试结论**:
| Electron | V8 | isolated-vm 编译 |
|----------|----|------------------|
| 33 | 13.0 | ✅ |
| 38 | 14.0 | ✅ ← 最高兼容 |
| 39 | 14.2 | ❌ GetIsolate 移除 |
| 40 | 14.4 | ❌ 同上 + GetPrototype 改名 |

**最终决策**: 升级到 Electron 38（V8 14.0, Node 22.16, Chromium 140），获得 12 个月安全补丁 + Node LTS 跳代

### 2026-02-08: gen5.test.ts VectorStore mock 缺少 save()

**症状**: 4 个 `memory_store` 测试失败，`result.success` 为 false

**根因**: `store.ts:92` 调用 `await vectorStore.save()`，但测试 mock 只有 `addKnowledge`、`search`、`indexCode`，缺少 `save` 方法

**修复**: 添加 `save: vi.fn().mockResolvedValue(undefined)` 到 VectorStore mock

### 2026-02-11: 打包后启动闪退 — 原生模块 ABI 不匹配 ✅ 已修复

**症状**: v0.16.37 安装后启动 4-6 秒即 SIGABRT，macOS 弹出 "Code Agent quit unexpectedly"

**误判过程**:
1. 崩溃报告显示 keytar.node 的 N-API cleanup hook abort → 误以为是 Keychain 问题
2. 第一次从终端运行才看到真正错误（SIGABRT 不 flush stdout，崩溃报告只有 native 栈）

**真正的错误**:
```
better_sqlite3.node was compiled against NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 139.
```

**根因链**:
1. 打包前没执行 `npm run rebuild-native`，better-sqlite3 仍是系统 Node.js（v127）编译版本
2. Electron 38 内置 Node.js 需要 v139 → 加载 .node 文件失败
3. 数据库初始化抛出 FATAL ERROR → 主进程开始 quit
4. quit 过程中 keytar 的 N-API cleanup hook 在非 JS 上下文调用 `ThrowAsJavaScriptException()` → C++ `std::terminate` → SIGABRT

**修复**: 打包清单第 4 步显式加入 `npm run rebuild-native`

**教训**:
- `postinstall` 不可靠：`npm rebuild`（CLI 测试）、手动操作都会覆盖 Electron 编译的原生模块
- 崩溃报告的 native 栈帧可能指向"陪葬"模块而非根因 — 永远从终端运行一次看 JS 层报错
- NODE_MODULE_VERSION 速查：127=Node 22.x（系统），139=Electron 38
