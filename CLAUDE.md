# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 的 8 个架构代际来研究 AI Agent 能力演进。

## 技术栈

- **框架**: Electron 33 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS
- **状态**: Zustand
- **AI**: DeepSeek API（主）, OpenAI/Claude（备）
- **后端**: Supabase + pgvector

## 文档结构

```
docs/
├── ARCHITECTURE.md       # 架构索引（入口）
├── PRD.md               # 产品需求文档
├── architecture/        # 详细架构文档
│   ├── overview.md      # 系统概览
│   ├── agent-core.md    # Agent 核心
│   ├── tool-system.md   # 工具系统
│   ├── frontend.md      # 前端架构
│   ├── data-storage.md  # 数据存储
│   └── cloud-architecture.md # 云端架构
└── decisions/           # 架构决策记录 (ADR)
    └── 001-turn-based-messaging.md
```

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

## 开发规范

### 类型检查

- **边开发边验证**：写完一个功能点后立即运行 `npm run typecheck`
- **提交前必检**：commit 前 typecheck 必须通过
- **允许临时 any**：原型阶段可用 `as any` 绕过，但必须标注 `// TODO: 修复类型`
- **接口改动要追溯**：修改 interface/type 后，检查所有引用处是否需要同步更新

### 常见类型错误模式

| 错误模式 | 原因 | 预防 |
|---------|------|------|
| `isCloud` vs `fromCloud` | 不同文件命名不一致 | 改接口时全局搜索引用 |
| Supabase 类型错误 | 缺少生成的类型定义 | 用 `as any` 临时绕过并标 TODO |
| `unknown` 转 `ReactNode` | Record<string, unknown> 取值 | 显式类型断言 |

### 验证节奏

```
写代码 → typecheck → 修复 → 功能测试 → commit
```

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

### 类型错误积累
**问题**: 多个功能并行开发后合并，积累了大量类型错误（接口不一致、命名冲突）
**正确做法**: 每个功能点完成后立即 `npm run typecheck`，不要等到最后一起修

### 发布清单

```
□ 代码改动已测试
□ npm run typecheck 通过
□ package.json 版本号已递增
□ cloud-agent/api/update.ts 已更新
□ 已 commit 并 push
□ 当前目录是主仓库
□ API 验证通过
□ npm run build
□ npm run dist:mac
```
