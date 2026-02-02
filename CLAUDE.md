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
| [docs/guides/model-config.md](docs/guides/model-config.md) | 模型配置矩阵 |
| [docs/guides/deployment.md](docs/guides/deployment.md) | 部署配置指南 |
| [docs/guides/git-workflow.md](docs/guides/git-workflow.md) | Git 分支工作流 |
| [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md) | 问题排查（错题本）|

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   │   └── subagent/    # 🆕 Subagent 4层架构 (v0.16.12+)
│   ├── generation/      # GenerationManager, prompts/
│   ├── tools/           # gen1-gen8 工具实现
│   ├── scheduler/       # DAG 调度器 (v0.16+)
│   ├── core/            # DI 容器、生命周期管理
│   ├── security/        # 安全模块 (v0.9+)
│   ├── hooks/           # Hooks 系统 (v0.9+)
│   ├── context/         # 上下文管理 (v0.9+)
│   ├── services/        # Auth, Sync, Database, FileCheckpoint
│   ├── channels/        # 🆕 多渠道接入 (v0.16.11+)
│   ├── skills/          # 🆕 用户可定义技能 (v0.16.11+)
│   ├── cli/             # 🆕 CLI 接口 (v0.16.11+)
│   └── memory/          # 向量存储和记忆系统
├── renderer/            # React 前端
│   ├── components/      # UI 组件
│   │   ├── features/workflow/  # DAG 可视化
│   │   └── features/lab/       # 🆕 实验室模块
│   ├── stores/          # Zustand 状态
│   │   └── dagStore.ts  # DAG 状态管理
│   └── hooks/           # 自定义 hooks
└── shared/              # 类型定义和 IPC
    └── types/
        ├── taskDAG.ts       # DAG 类型定义
        ├── builtInAgents.ts # 内置 Agent 定义
        └── workflow.ts      # 工作流类型
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

### 2026-02-02: 原生模块必须用 Electron headers 重编译

**症状**：
```
Error: The module was compiled against a different Node.js version
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 130.
```

**原因**：原生模块（isolated-vm, better-sqlite3, keytar）使用系统 Node.js 编译，与 Electron 内置的 Node.js 版本不匹配。

**解决方案**：
```bash
npm cache clean --force
rm -rf node_modules/isolated-vm node_modules/better-sqlite3 node_modules/keytar
npm install isolated-vm better-sqlite3 keytar --build-from-source --runtime=electron --target=33.4.11 --disturl=https://electronjs.org/headers
```

**关键点**：
- 每次 `npm install` 后都需要重编译
- `electron-rebuild` 不可靠，手动指定 Electron headers 更稳定
- 打包前**必须**执行此步骤

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
