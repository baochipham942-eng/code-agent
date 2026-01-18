# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 的 8 个架构代际来研究 AI Agent 能力演进。

## 技术栈

- **框架**: Electron 33 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS
- **状态**: Zustand
- **AI**: DeepSeek API（主）, OpenAI/Claude（备）
- **后端**: Supabase + pgvector

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   ├── generation/      # GenerationManager
│   ├── tools/           # gen1-gen4 工具实现
│   ├── services/        # Auth, Sync, Database
│   └── memory/          # 向量存储和记忆系统
├── preload/             # 预加载脚本
├── renderer/            # React 前端
│   ├── components/      # UI 组件
│   ├── stores/          # Zustand 状态
│   └── hooks/           # 自定义 hooks
└── shared/              # 类型定义和 IPC
```

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 构建
npm run dist:mac     # 打包 macOS
npm run typecheck    # 类型检查
```

## 8 代工具演进

| 代际 | 工具集 |
|------|--------|
| Gen1 | bash, read_file, write_file, edit_file |
| Gen2 | + glob, grep, list_directory |
| Gen3 | + task, todo_write, ask_user_question |
| Gen4 | + skill, web_fetch |
| Gen5 | + memory_store, memory_search, code_index |
| Gen6 | + screenshot, computer_use, browser_action |
| Gen7 | + spawn_agent, agent_message, workflow_orchestrate |
| Gen8 | + strategy_optimize, tool_create, self_evaluate |

## 版本号规范

- **PATCH**: Bug 修复、小改动 (0.3.0 → 0.3.1)
- **MINOR**: 新功能 (0.3.1 → 0.4.0)
- **MAJOR**: 架构重构 (0.4.0 → 1.0.0)

代际版本 (v1.0-v8.0) 表示 Agent 能力等级，与应用版本独立。

---

## 部署配置

### Vercel

| 配置项 | 值 |
|--------|-----|
| 项目名 | `code-agent` |
| 域名 | `https://code-agent-beta.vercel.app` |
| Root Directory | `cloud-agent`（不是 cloud-api）|

```bash
# 验证部署
curl -s "https://code-agent-beta.vercel.app/api/update?action=health"
```

### API 目录

| 目录 | 状态 |
|------|------|
| `cloud-agent/` | ✅ 正在使用 |
| `cloud-api/` | ❌ 已废弃，不要修改 |

---

## 错题本

### Vercel 部署目录混淆
**问题**: 修改 `cloud-api/` 但 Vercel 部署的是 `cloud-agent/`
**正确做法**: 只修改 `cloud-agent/api/update.ts`

### 打包位置错误
**问题**: 在 worktree 中执行 `npm run dist:mac`，产物在 worktree 的 `release/` 下
**正确做法**: 切换到主仓库后再打包

### 版本号遗漏
**问题**: 修改代码后直接打包，忘记更新版本号
**正确做法**: 每次修改客户端代码必须递增 package.json 版本号

### 发布清单

```
□ 代码改动已测试
□ package.json 版本号已递增
□ cloud-agent/api/update.ts 已更新
□ 已 commit 并 push
□ 当前目录是主仓库
□ API 验证通过
□ npm run build
□ npm run dist:mac
```
