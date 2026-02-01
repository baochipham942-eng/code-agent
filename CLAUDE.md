# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 的 8 个架构代际来研究 AI Agent 能力演进。

## 技术栈

- **框架**: Electron 33 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS
- **状态**: Zustand
- **AI**: DeepSeek API（主）, 智谱/OpenAI（备）
- **后端**: Supabase + pgvector

## 文档导航

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构索引（入口）|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/guides/tools-reference.md](docs/guides/tools-reference.md) | 工具完整参考手册 |
| [docs/guides/deployment.md](docs/guides/deployment.md) | 部署配置指南 |
| [docs/guides/git-workflow.md](docs/guides/git-workflow.md) | Git 分支工作流 |
| [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md) | 问题排查（错题本）|

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   ├── generation/      # GenerationManager, prompts/
│   ├── tools/           # gen1-gen8 工具实现
│   ├── scheduler/       # 🆕 DAG 调度器 (v0.16+)
│   ├── core/            # 🆕 DI 容器、生命周期管理
│   ├── security/        # 安全模块 (v0.9+)
│   ├── hooks/           # Hooks 系统 (v0.9+)
│   ├── context/         # 上下文管理 (v0.9+)
│   ├── services/        # Auth, Sync, Database
│   └── memory/          # 向量存储和记忆系统
├── renderer/            # React 前端
│   ├── components/      # UI 组件
│   │   └── features/workflow/  # 🆕 DAG 可视化
│   ├── stores/          # Zustand 状态
│   │   └── dagStore.ts  # 🆕 DAG 状态管理
│   └── hooks/           # 自定义 hooks
└── shared/              # 类型定义和 IPC
    └── types/
        ├── taskDAG.ts       # 🆕 DAG 类型定义
        ├── builtInAgents.ts # 🆕 内置 Agent 定义
        └── workflow.ts      # 🆕 工作流类型
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

## 子 Agent 系统 (Gen7)

**核心角色（6 个）**：`coder`、`reviewer`、`tester`、`architect`、`debugger`、`documenter`

**扩展角色（11 个）**：

| 分类 | 角色 | 说明 |
|------|------|------|
| 本地搜索 | `code-explore` | 代码库搜索（只读）|
| 本地搜索 | `doc-reader` | 本地文档读取（PDF/Word/Excel）|
| 外部搜索 | `web-search` | 网络搜索 |
| 外部搜索 | `mcp-connector` | MCP 服务连接 |
| 视觉 | `visual-understanding` | 图片分析 |
| 视觉 | `visual-processing` | 图片编辑 |
| 元 | `plan` | 任务规划 |
| 元 | `bash-executor` | 命令执行 |
| 元 | `general-purpose` | 通用 Agent |
| 代码 | `refactorer` | 代码重构 |
| DevOps | `devops` | CI/CD |

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

配置位置：`.claude/settings.json`

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
# 4. 重编译原生模块（必须用 Electron headers，electron-rebuild 不可靠）
npm cache clean --force
rm -rf node_modules/isolated-vm node_modules/better-sqlite3 node_modules/keytar
npm install isolated-vm better-sqlite3 keytar --build-from-source --runtime=electron --target=33.4.11 --disturl=https://electronjs.org/headers
# 5. 打包
rm -rf release/ && npm run dist:mac
# 6. 安装后同步 .env
cp .env "/Applications/Code Agent.app/Contents/Resources/.env"
```

### 本地数据库
```
~/Library/Application Support/code-agent/code-agent.db
```

### 问题排查
详见 [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md)
