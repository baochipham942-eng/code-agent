# MCP 扩展实现计划

## 目标

扩展 Code Agent 的 MCP 生态，增加高价值的 MCP 服务器，提升 AI 编程助手的能力边界。

## 现有架构分析

### 当前 MCP 支持

```
传输协议：
├── SSE (远程)     - deepwiki ✅
├── Stdio (本地)   - github, filesystem, git, brave-search, memory
└── In-Process     - log-bridge ✅
```

### 配置来源优先级

```
云端配置 (cloudConfigService)
  ↓ 降级
内置配置 (builtinConfig.ts)
  ↓ 覆盖
自定义配置 (initMCPClient customConfigs)
```

### Skill 挂载机制

```
~/.claude/skills/          # 用户级
.claude/skills/            # 项目级
cloudConfigService         # 云端/内置
```

---

## 实现阶段

### Phase 1: 核心 MCP 服务器集成 (2-3 天)

#### 1.1 Context7 - 文档检索 (远程 SSE)

**价值**：编程时实时查询库/框架文档，比 web_fetch 更精准

```typescript
// builtinConfig.ts 新增
{
  id: 'context7',
  name: 'Context7',
  type: 'sse',
  enabled: true,
  config: { url: 'https://mcp.context7.com/sse' },
  description: '库和框架文档检索，支持 React/Vue/Node 等主流技术栈',
}
```

**工具**：
- `resolve-library-id` - 解析库名到 ID
- `get-library-docs` - 获取库文档

**与 Skill 结合**：
```markdown
<!-- ~/.claude/skills/doc-lookup/SKILL.md -->
---
name: doc-lookup
description: 查询技术文档
allowed-tools: [mcp_context7_resolve-library-id, mcp_context7_get-library-docs]
---
```

#### 1.2 Sequential Thinking - 思维链 (本地 Stdio)

**价值**：复杂任务拆解，提升推理质量

```typescript
{
  id: 'sequential-thinking',
  name: 'Sequential Thinking',
  type: 'stdio',
  enabled: true,
  config: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  description: '结构化思维链推理，适合复杂问题分析',
}
```

**工具**：
- `create_thinking_session` - 创建思维会话
- `add_thought` - 添加思考步骤
- `get_thinking_summary` - 获取思维总结

#### 1.3 Puppeteer - 浏览器自动化 (本地 Stdio)

**价值**：增强 Gen6 browser_action，支持更复杂的网页交互

```typescript
{
  id: 'puppeteer',
  name: 'Puppeteer',
  type: 'stdio',
  enabled: false, // 需要 Chromium，默认禁用
  config: {
    command: 'npx',
    args: ['-y', '@anthropics/mcp-server-puppeteer'],
  },
  description: '浏览器自动化（需要 Chromium 环境）',
}
```

---

### Phase 2: 搜索与网络能力增强 (2 天)

#### 2.1 Exa Search - 智能搜索 (远程 SSE)

**价值**：比 Brave Search 更智能的语义搜索

```typescript
{
  id: 'exa',
  name: 'Exa Search',
  type: 'sse',
  enabled: false, // 需要 API Key
  config: { url: 'https://mcp.exa.ai/sse' },
  requiredEnvVars: ['EXA_API_KEY'],
  description: '语义搜索引擎，理解自然语言查询',
}
```

#### 2.2 Firecrawl - 网页抓取 (远程 SSE)

**价值**：web_fetch 增强版，处理 JS 渲染页面

```typescript
{
  id: 'firecrawl',
  name: 'Firecrawl',
  type: 'sse',
  enabled: false, // 需要 API Key
  config: { url: 'https://mcp.firecrawl.dev/sse' },
  requiredEnvVars: ['FIRECRAWL_API_KEY'],
  description: '高级网页抓取，支持 JS 渲染和结构化提取',
}
```

---

### Phase 3: 开发工具增强 (2 天)

#### 3.1 Docker MCP (本地 Stdio)

**价值**：容器管理，开发环境标准化

```typescript
{
  id: 'docker',
  name: 'Docker',
  type: 'stdio',
  enabled: false,
  config: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-docker'],
  },
  description: 'Docker 容器管理',
}
```

#### 3.2 PostgreSQL MCP (本地 Stdio)

**价值**：数据库操作，与项目 Supabase 配合

```typescript
{
  id: 'postgres',
  name: 'PostgreSQL',
  type: 'stdio',
  enabled: false,
  config: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: { DATABASE_URL: '${DATABASE_URL}' },
  },
  requiredEnvVars: ['DATABASE_URL'],
  description: 'PostgreSQL 数据库操作',
}
```

---

### Phase 4: In-Process MCP 服务器 (3 天)

#### 4.1 Memory KV Server

**价值**：会话内高速 KV 存储，无 IPC 开销

```typescript
// src/main/mcp/servers/memoryKVServer.ts
export class MemoryKVServer implements InProcessMCPServerInterface {
  name = 'memory-kv';
  private store = new Map<string, unknown>();

  async listTools(): Promise<MCPTool[]> {
    return [
      { name: 'kv_set', description: '设置键值', serverName: this.name, inputSchema: {...} },
      { name: 'kv_get', description: '获取值', serverName: this.name, inputSchema: {...} },
      { name: 'kv_delete', description: '删除键', serverName: this.name, inputSchema: {...} },
      { name: 'kv_list', description: '列出所有键', serverName: this.name, inputSchema: {...} },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // 实现 KV 操作
  }
}
```

#### 4.2 Code Index Server

**价值**：代码符号索引，快速跳转定义/引用

```typescript
// src/main/mcp/servers/codeIndexServer.ts
export class CodeIndexServer implements InProcessMCPServerInterface {
  name = 'code-index';

  async listTools(): Promise<MCPTool[]> {
    return [
      { name: 'index_project', description: '索引项目', ... },
      { name: 'find_definition', description: '查找定义', ... },
      { name: 'find_references', description: '查找引用', ... },
      { name: 'search_symbols', description: '搜索符号', ... },
    ];
  }
}
```

---

### Phase 5: MCP 管理 UI (2 天)

#### 5.1 设置页面增强

```
Settings → MCP Servers
├── 服务器列表（状态指示灯）
├── 启用/禁用切换
├── 连接状态监控
├── 日志查看
└── 添加自定义服务器
```

#### 5.2 状态栏集成

```
[MCP: 3/5 connected] ← 点击展开详情
```

---

### Phase 6: MCP-Skill 深度整合 (2 天)

#### 6.1 MCP-backed Skills

创建依赖特定 MCP 的 Skills：

```markdown
<!-- ~/.claude/skills/web-research/SKILL.md -->
---
name: web-research
description: 深度网络研究，综合多个搜索源
required-mcp: [exa, firecrawl, context7]
allowed-tools:
  - mcp_exa_search
  - mcp_firecrawl_scrape
  - mcp_context7_get-library-docs
---

## 工作流程

1. 使用 exa 进行语义搜索
2. 使用 firecrawl 抓取相关页面
3. 使用 context7 补充技术文档
4. 综合分析并输出报告
```

#### 6.2 自动 MCP 启用

当 Skill 需要特定 MCP 时，自动提示启用：

```typescript
// skillDiscoveryService.ts
async getSkillWithMCPCheck(name: string): Promise<{
  skill: ParsedSkill;
  missingMCP: string[];
}> {
  const skill = this.getSkill(name);
  const requiredMCP = skill.metadata?.requiredMcp || [];
  const mcpClient = getMCPClient();
  const missingMCP = requiredMCP.filter(id => !mcpClient.isConnected(id));
  return { skill, missingMCP };
}
```

---

## 文件改动清单

### 新增文件

```
src/main/mcp/servers/
├── memoryKVServer.ts        # In-Process KV 存储
├── codeIndexServer.ts       # In-Process 代码索引
└── index.ts                 # 统一导出

src/renderer/components/features/settings/
└── MCPSettingsTab.tsx       # MCP 设置页面
```

### 修改文件

```
src/main/services/cloud/builtinConfig.ts
  - 新增 MCP 服务器配置

src/main/mcp/mcpClient.ts
  - 注册 In-Process 服务器

src/main/services/skills/skillDiscoveryService.ts
  - 增加 MCP 依赖检查

src/renderer/components/features/settings/SettingsModal.tsx
  - 新增 MCP 设置 Tab
```

---

## 优先级排序

| 阶段 | 工作量 | 价值 | 优先级 |
|------|--------|------|--------|
| Phase 1.1 Context7 | 0.5天 | ⭐⭐⭐⭐⭐ | P0 |
| Phase 1.2 Sequential Thinking | 0.5天 | ⭐⭐⭐⭐ | P0 |
| Phase 4.1 Memory KV | 1天 | ⭐⭐⭐⭐ | P1 |
| Phase 5 UI | 2天 | ⭐⭐⭐⭐ | P1 |
| Phase 2 搜索增强 | 2天 | ⭐⭐⭐ | P2 |
| Phase 3 开发工具 | 2天 | ⭐⭐⭐ | P2 |
| Phase 4.2 Code Index | 2天 | ⭐⭐⭐ | P2 |
| Phase 6 Skill 整合 | 2天 | ⭐⭐⭐⭐ | P2 |

---

## 验收标准

### Phase 1 完成标准

- [ ] Context7 SSE 连接成功
- [ ] 可通过 `mcp_context7_get-library-docs` 查询 React 文档
- [ ] Sequential Thinking 本地启动成功
- [ ] 创建思维会话并获取总结

### Phase 4 完成标准

- [ ] Memory KV 无 IPC 延迟（<1ms）
- [ ] Code Index 支持 TypeScript 符号解析
- [ ] 与现有 Gen5 memory 系统兼容

### Phase 5 完成标准

- [ ] 设置页面显示所有 MCP 状态
- [ ] 可切换启用/禁用
- [ ] 连接错误有清晰提示

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SSE 服务不稳定 | 功能不可用 | 自动重连 + 降级提示 |
| Stdio 启动慢 | 用户体验差 | 懒加载 + 进度提示 |
| API Key 配置复杂 | 用户流失 | 引导式配置 + 云端代理 |
| In-Process 内存泄漏 | 应用崩溃 | 内存监控 + 自动清理 |

---

## 下一步行动

1. **立即开始**：Phase 1.1 Context7 集成
2. **本周完成**：Phase 1 全部 + Phase 5 UI 基础
3. **下周完成**：Phase 4 In-Process 服务器

---

## 并行开发策略

### 工作流依赖分析

```
                    ┌─────────────────────────────────────────┐
                    │         builtinConfig.ts                │
                    │    (MCP 服务器配置 - 共享基础)            │
                    └──────────────────┬──────────────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
    ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
    │  远程 SSE    │           │  本地 Stdio  │           │  In-Process  │
    │  服务器集成   │           │  服务器集成   │           │   服务器开发  │
    └──────────────┘           └──────────────┘           └──────────────┘
           │                           │                           │
           │                           │                           │
           ▼                           ▼                           ▼
    ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
    │ context7     │           │ seq-thinking │           │ memory-kv    │
    │ exa          │           │ puppeteer    │           │ code-index   │
    │ firecrawl    │           │ docker       │           │              │
    └──────────────┘           └──────────────┘           └──────────────┘
           │                           │                           │
           └───────────────────────────┴───────────────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │   MCP 设置 UI    │
                            │  (依赖上述完成)   │
                            └──────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │  Skill 整合      │
                            │ (依赖 UI + MCP)  │
                            └──────────────────┘
```

### 并行工作流分配

#### 🔀 可完全并行的工作流（无依赖）

| 工作流 | 负责内容 | 预计时间 | 前置条件 |
|--------|---------|---------|---------|
| **Worktree A** | 远程 SSE 服务器 | 2 天 | 无 |
| **Worktree B** | 本地 Stdio 服务器 | 2 天 | 无 |
| **Worktree C** | In-Process 服务器 | 3 天 | 无 |

#### 📋 每个 Worktree 的任务清单

**Worktree A: 远程 SSE 服务器** (`feature/mcp-sse-servers`)
```bash
git worktree add ~/.claude-worktrees/code-agent/mcp-sse ../feature/mcp-sse-servers
```

任务：
1. [ ] `builtinConfig.ts` 添加 context7、exa、firecrawl 配置
2. [ ] 测试 SSE 连接稳定性
3. [ ] 添加自动重连机制
4. [ ] 编写集成测试

**Worktree B: 本地 Stdio 服务器** (`feature/mcp-stdio-servers`)
```bash
git worktree add ~/.claude-worktrees/code-agent/mcp-stdio ../feature/mcp-stdio-servers
```

任务：
1. [ ] `builtinConfig.ts` 添加 sequential-thinking、puppeteer、docker 配置
2. [ ] 实现懒加载机制（按需启动）
3. [ ] 添加启动超时处理
4. [ ] 编写集成测试

**Worktree C: In-Process 服务器** (`feature/mcp-inprocess-servers`)
```bash
git worktree add ~/.claude-worktrees/code-agent/mcp-inprocess ../feature/mcp-inprocess-servers
```

任务：
1. [ ] 创建 `src/main/mcp/servers/memoryKVServer.ts`
2. [ ] 创建 `src/main/mcp/servers/codeIndexServer.ts`
3. [ ] 在 `mcpClient.ts` 注册 In-Process 服务器
4. [ ] 编写单元测试

---

### 合并策略

#### 阶段 1: 配置合并（Day 3）

三个分支都会修改 `builtinConfig.ts`，需要协调：

```typescript
// 建议：每个分支只添加自己的服务器配置
// Worktree A 添加:
{ id: 'context7', type: 'sse', ... },
{ id: 'exa', type: 'sse', ... },
{ id: 'firecrawl', type: 'sse', ... },

// Worktree B 添加:
{ id: 'sequential-thinking', type: 'stdio', ... },
{ id: 'puppeteer', type: 'stdio', ... },
{ id: 'docker', type: 'stdio', ... },

// Worktree C 不修改 builtinConfig.ts（In-Process 通过代码注册）
```

合并顺序：
```bash
# 1. 先合并 A (SSE)
git checkout main && git merge feature/mcp-sse-servers

# 2. 再合并 B (Stdio) - 可能需要解决 builtinConfig.ts 冲突
git merge feature/mcp-stdio-servers

# 3. 最后合并 C (In-Process) - 无冲突
git merge feature/mcp-inprocess-servers
```

#### 阶段 2: UI 开发（Day 4-5）

在合并完成后，开始 UI 开发：

```bash
git worktree add ~/.claude-worktrees/code-agent/mcp-ui ../feature/mcp-settings-ui
```

---

### 并行开发检查清单

#### 开始前准备

```bash
# 1. 确保 main 分支是最新的
cd /Users/linchen/Downloads/ai/code-agent
git checkout main && git pull

# 2. 创建三个功能分支
git branch feature/mcp-sse-servers
git branch feature/mcp-stdio-servers
git branch feature/mcp-inprocess-servers

# 3. 创建三个 worktree
git worktree add ~/.claude-worktrees/code-agent/mcp-sse feature/mcp-sse-servers
git worktree add ~/.claude-worktrees/code-agent/mcp-stdio feature/mcp-stdio-servers
git worktree add ~/.claude-worktrees/code-agent/mcp-inprocess feature/mcp-inprocess-servers
```

#### 每日同步

```bash
# 每天开始时，从 main 同步最新代码
git fetch origin
git rebase origin/main
```

#### 合并前检查

```bash
# 每个分支合并前
npm run typecheck
npm run build
npm test
```

---

### Claude Code 多 Agent 并行模式

如果使用 Claude Code 开发，可以启动 3 个并行 Agent：

```bash
# Terminal 1 - SSE 服务器
cd ~/.claude-worktrees/code-agent/mcp-sse
claude --dangerously-skip-permissions --print "实现 Context7、Exa、Firecrawl SSE MCP 服务器集成，参考 docs/plans/mcp-expansion-plan.md 中的 Phase 1 和 Phase 2 SSE 部分"

# Terminal 2 - Stdio 服务器
cd ~/.claude-worktrees/code-agent/mcp-stdio
claude --dangerously-skip-permissions --print "实现 Sequential Thinking、Puppeteer、Docker Stdio MCP 服务器集成，参考 docs/plans/mcp-expansion-plan.md 中的 Phase 1 和 Phase 3 Stdio 部分"

# Terminal 3 - In-Process 服务器
cd ~/.claude-worktrees/code-agent/mcp-inprocess
claude --dangerously-skip-permissions --print "实现 Memory KV 和 Code Index In-Process MCP 服务器，参考 docs/plans/mcp-expansion-plan.md 中的 Phase 4 In-Process 部分"
```

**参数说明**：
- `--dangerously-skip-permissions`: 跳过所有权限确认，自动执行工具调用
- `--print`: 非交互模式，执行完任务后退出（输出到 stdout）

---

### 时间线

```
Day 1-2:  ├── Worktree A: SSE ────────────┤
          ├── Worktree B: Stdio ──────────┤
          ├── Worktree C: In-Process ─────┤

Day 3:    合并 A + B + C → main

Day 4-5:  ├── UI 开发 ────────────────────┤

Day 6:    合并 UI → main

Day 7:    ├── Skill 整合 + 测试 ──────────┤
```

**总计：7 天完成所有 Phase，比串行快 50%**
