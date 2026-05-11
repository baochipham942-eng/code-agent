# 云端与本地协同架构

> Gen 5-8 演进的核心基础设施
>
> 2026-05-10 状态：本文大部分 cloud task / cloud agent / orchestrator 内容是历史设计归档。近两周已删除旧 `src/main/cloud/*`、cloud agent module、POC cloud tools 和相关 legacy provider path。当前仍保留的 cloud 相关代码主要在 `src/main/services/cloud/`，用于 cloud config、prompt/update、feature flag、orchestrator config 和 cloud proxy 边界；不要把本文里的云端任务调度当作当前 active path。

## 架构总览

云端与本地协同实现：
- **本地**：负责"手脚"（文件操作、终端执行、UI 交互）
- **云端**：负责"大脑"（复杂推理、多代理调度、跨设备记忆）

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Cloud-Local Hybrid Architecture                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     Local Client (Electron App)                          │   │
│   │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐               │   │
│   │  │  Local Agent   │ │  Task Router   │ │  Sync Engine   │               │   │
│   │  │    Loop        │ │                │ │                │               │   │
│   │  └───────┬────────┘ └───────┬────────┘ └───────┬────────┘               │   │
│   │          │                  │                  │                         │   │
│   │  ┌───────┴──────────────────┴──────────────────┴────────┐               │   │
│   │  │                   Local Executor                      │               │   │
│   │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │               │   │
│   │  │  │  File   │ │  Shell  │ │   Git   │ │Computer │    │               │   │
│   │  │  │  Ops    │ │  Exec   │ │   Ops   │ │  Use    │    │               │   │
│   │  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘    │               │   │
│   │  └──────────────────────────────────────────────────────┘               │   │
│   └────────────────────────────────┬────────────────────────────────────────┘   │
│                                    │                                             │
│                          WebSocket │ + REST API                                  │
│                                    │                                             │
│   ┌────────────────────────────────┴────────────────────────────────────────┐   │
│   │                        Supabase Cloud Platform                           │   │
│   │                                                                          │   │
│   │  ┌─────────────────────────────────────────────────────────────────┐    │   │
│   │  │                     Edge Functions Layer                         │    │   │
│   │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │    │   │
│   │  │  │   Task     │ │  Agent     │ │  Workflow  │ │  Strategy  │   │    │   │
│   │  │  │  Router    │ │ Scheduler  │ │  Engine    │ │  Optimizer │   │    │   │
│   │  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │    │   │
│   │  └─────────────────────────────────────────────────────────────────┘    │   │
│   │                                                                          │   │
│   │  ┌─────────────────────────────────────────────────────────────────┐    │   │
│   │  │                     Data Layer                                   │    │   │
│   │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │    │   │
│   │  │  │   Task     │ │   Agent    │ │  Vector    │ │  Strategy  │   │    │   │
│   │  │  │   Queue    │ │   State    │ │   Store    │ │   Cache    │   │    │   │
│   │  │  │ (Postgres) │ │ (Postgres) │ │ (pgvector) │ │  (Redis)   │   │    │   │
│   │  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │    │   │
│   │  └─────────────────────────────────────────────────────────────────┘    │   │
│   │                                                                          │   │
│   │  ┌─────────────────────────────────────────────────────────────────┐    │   │
│   │  │                     AI Services Layer                            │    │   │
│   │  │              Claude Agent SDK (Anthropic)                        │    │   │
│   │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐               │    │   │
│   │  │  │ Planner │ │  Coder  │ │Reviewer │ │Researcher│               │    │   │
│   │  │  │  Agent  │ │  Agent  │ │  Agent  │ │  Agent  │               │    │   │
│   │  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘               │    │   │
│   │  └─────────────────────────────────────────────────────────────────┘    │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 任务分类与路由策略

### 任务分类矩阵

| 任务类型 | 执行位置 | 原因 | 示例 |
|----------|----------|------|------|
| **文件系统操作** | 🏠 本地 | 需要本地文件访问权限 | read_file, write_file, edit_file |
| **终端命令执行** | 🏠 本地 | 需要本地环境和工具链 | bash, npm, git |
| **Computer Use** | 🏠 本地 | 需要本地屏幕和输入设备 | screenshot, click, type |
| **敏感代码处理** | 🏠 本地 | 隐私和安全考虑 | 含密钥/凭证的代码 |
| **实时 UI 交互** | 🏠 本地 | 需要即时响应 | ask_user_question |
| **代码审查分析** | ☁️ 云端 | 纯推理任务，无本地依赖 | review_code |
| **文档生成** | ☁️ 云端 | 可离线完成，结果同步 | generate_docs |
| **多文件重构规划** | ☁️ 云端 | 复杂推理，云端算力更强 | plan_refactor |
| **跨项目知识检索** | ☁️ 云端 | 云端向量库统一管理 | semantic_search |
| **多代理协同** | ☁️ 云端 | 云端调度多个 Agent 更高效 | multi_agent_task |
| **大型重构执行** | 🔄 混合 | 云端规划 + 本地执行 | refactor_module |

### 任务路由器设计

```typescript
// src/main/cloud/TaskRouter.ts

export type TaskTarget = 'local' | 'cloud' | 'hybrid';

export interface RoutingRule {
  pattern: RegExp | string[];
  target: TaskTarget;
  priority: number;
  condition?: (task: Task) => boolean;
}

export class TaskRouter {
  private rules: RoutingRule[] = [
    // 必须本地执行
    {
      pattern: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
      target: 'local',
      priority: 100,
    },
    {
      pattern: ['screenshot', 'computer_use', 'click', 'type', 'scroll'],
      target: 'local',
      priority: 100,
    },
    {
      pattern: ['ask_user_question'],
      target: 'local',
      priority: 100,
    },

    // 必须云端执行
    {
      pattern: ['cross_project_search', 'semantic_search'],
      target: 'cloud',
      priority: 90,
    },
    {
      pattern: ['spawn_multi_agent', 'agent_orchestrate'],
      target: 'cloud',
      priority: 90,
    },

    // 混合模式：根据任务复杂度判断
    {
      pattern: ['refactor', 'implement_feature'],
      target: 'hybrid',
      priority: 80,
      condition: (task) => this.estimateComplexity(task) > 5,
    },

    // 可云端加速的纯推理任务
    {
      pattern: ['code_review', 'generate_docs', 'explain_code'],
      target: 'cloud',
      priority: 70,
      condition: (task) => this.isCloudAvailable(),
    },

    // 默认本地
    {
      pattern: /.*/,
      target: 'local',
      priority: 0,
    },
  ];

  route(task: Task): TaskTarget {
    const sortedRules = [...this.rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.matchRule(task, rule)) {
        if (!rule.condition || rule.condition(task)) {
          return rule.target;
        }
      }
    }

    return 'local';
  }

  private estimateComplexity(task: Task): number {
    let score = 0;
    if (task.metadata?.fileCount) score += task.metadata.fileCount;
    if (task.metadata?.estimatedChanges) score += task.metadata.estimatedChanges / 100;
    return score;
  }
}
```

---

## 云端任务队列系统

### 数据库设计

```sql
-- 云端任务队列表
CREATE TABLE cloud_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id),
  session_id UUID REFERENCES sessions(id),

  -- 任务定义
  type TEXT NOT NULL,                    -- 'code_review', 'refactor_plan', 'multi_agent'
  name TEXT NOT NULL,                    -- 人类可读的任务名称
  description TEXT,                      -- 任务描述

  -- 状态管理
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),

  -- 输入输出
  input JSONB NOT NULL,                  -- 任务输入参数
  result JSONB,                          -- 执行结果
  error JSONB,                           -- 错误信息

  -- 执行元数据
  agent_type TEXT,                       -- 使用的 Agent 类型
  agent_config JSONB,                    -- Agent 配置
  tokens_used INTEGER DEFAULT 0,
  estimated_tokens INTEGER,

  -- 进度追踪
  progress INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_step TEXT,
  total_steps INTEGER,
  completed_steps INTEGER DEFAULT 0,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT now(),
  queued_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- 超时和重试
  timeout_seconds INTEGER DEFAULT 3600,  -- 默认 1 小时超时
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,

  -- 依赖关系
  parent_task_id UUID REFERENCES cloud_tasks(id),
  depends_on UUID[] DEFAULT '{}'::UUID[],

  -- 通知设置
  notify_on_complete BOOLEAN DEFAULT true,
  notify_channels TEXT[] DEFAULT '{}'::TEXT[]  -- 'push', 'email', 'webhook'
);

-- 任务日志表
CREATE TABLE task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  metadata JSONB,
  agent_id TEXT,
  step_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 任务执行步骤表
CREATE TABLE task_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input JSONB,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  -- 本地执行标记
  requires_local_execution BOOLEAN DEFAULT false,
  local_execution_request JSONB,
  local_execution_result JSONB,
  UNIQUE (task_id, step_index)
);

-- 索引优化
CREATE INDEX idx_cloud_tasks_user_status ON cloud_tasks(user_id, status);
CREATE INDEX idx_cloud_tasks_priority_status ON cloud_tasks(priority DESC, status)
  WHERE status IN ('pending', 'queued');
CREATE INDEX idx_task_logs_task_id ON task_logs(task_id, created_at DESC);

-- 实时订阅支持
ALTER PUBLICATION supabase_realtime ADD TABLE cloud_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE task_steps;
```

### 任务状态流转

```
pending → queued → running → completed
                      ↓
                   failed
                      ↓
                  retrying → running
                      ↓
                  cancelled
```

---

## 混合执行模式 (Hybrid Mode)

### 执行流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     Hybrid Task Execution Flow                                   │
│                     (云端规划 + 本地执行 + 云端审查)                              │
└─────────────────────────────────────────────────────────────────────────────────┘

用户请求: "重构 auth 模块，提取公共逻辑"
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: 云端规划 (Cloud Planning)                                               │
│                                                                                  │
│   Planner Agent (Claude) 生成重构计划:                                           │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │ Step 1: 创建 src/utils/authHelpers.ts [LOCAL: write_file]               │   │
│   │ Step 2: 提取 validateToken 函数 [LOCAL: edit_file]                      │   │
│   │ Step 3: 提取 refreshSession 函数 [LOCAL: edit_file]                     │   │
│   │ Step 4: 更新 AuthService 导入 [LOCAL: edit_file]                        │   │
│   │ Step 5: 运行测试验证 [LOCAL: bash npm test]                             │   │
│   │ Step 6: 代码审查 [CLOUD: review]                                        │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │ 计划下发
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: 本地执行 (Local Execution)                                              │
│                                                                                  │
│   Local Agent Loop:                                                              │
│   FOR EACH step WHERE requires_local_execution:                                  │
│     ├─ Step 1: write_file('src/utils/authHelpers.ts', content)                  │
│     ├─ Step 2-4: edit_file 修改相关文件                                         │
│     └─ Step 5: bash('npm test') → 上报结果到云端                                │
│                                                                                  │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │ 执行结果
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: 云端审查 (Cloud Review)                                                 │
│                                                                                  │
│   Reviewer Agent 审查报告:                                                       │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │ ✅ 代码结构改善                                                         │   │
│   │ ✅ 函数职责单一                                                         │   │
│   │ ⚠️ 建议: 添加 JSDoc 注释                                                │   │
│   │ ✅ 所有测试通过                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │
                                     ▼
                              通知用户完成
```

---

## 多代理云端调度 (Gen 7)

### 专业化 Agent 设计理念

**核心概念**: 专业化 Agent 不是使用不同的模型，而是**同一个底层模型 + 不同的 System Prompt + 不同的工具集**，让模型扮演不同的专业角色。

### 多模型支持（v0.6.0 实现）

云端 Agent 通过 `ModelClient` 统一抽象层支持多个模型提供商：

| Provider | 模型 | 特点 |
|----------|------|------|
| DeepSeek | deepseek-chat | 默认首选，性价比高 |
| OpenAI | gpt-4o | 综合能力强 |
| Anthropic | claude-sonnet-4 | 推理能力强 |

**模型选择优先级**: DeepSeek > OpenAI > Anthropic（按可用性自动回退）

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           专业化 Agent 架构                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ModelClient 统一抽象层                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │  DeepSeek API  │  OpenAI API  │  Anthropic API                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                           │                                                      │
│           ┌───────────────┼───────────────┬───────────────┐                     │
│           ▼               ▼               ▼               ▼                     │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│   │  Planner    │ │   Coder     │ │  Reviewer   │ │ Researcher  │              │
│   │  Agent      │ │   Agent     │ │   Agent     │ │   Agent     │              │
│   ├─────────────┤ ├─────────────┤ ├─────────────┤ ├─────────────┤              │
│   │ System:     │ │ System:     │ │ System:     │ │ System:     │              │
│   │ "你是任务   │ │ "你是代码   │ │ "你是代码   │ │ "你是技术   │              │
│   │  规划专家"  │ │  实现专家"  │ │  审查专家"  │ │  研究专家"  │              │
│   ├─────────────┤ ├─────────────┤ ├─────────────┤ ├─────────────┤              │
│   │ Tools:      │ │ Tools:      │ │ Tools:      │ │ Tools:      │              │
│   │ - analyze   │ │ (无工具,   │ │ - analyze   │ │ - search    │              │
│   │ - estimate  │ │  只生成)   │ │ - check     │ │ - web_fetch │              │
│   └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘              │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Agent 定义

```typescript
// supabase/functions/shared/agents.ts

export interface AgentSpec {
  id: string;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  systemPrompt: string;
  modelConfig: {
    provider: ModelProvider;
    model: string;
    maxTokens: number;
    temperature?: number;
  };
  tools: string[];
}

export const AGENT_SPECS: Record<string, AgentSpec> = {
  planner: {
    id: 'planner',
    name: 'Planner Agent',
    role: '任务规划与分解',
    description: '分析复杂任务，生成可执行的步骤计划',
    capabilities: ['task_decomposition', 'dependency_analysis', 'resource_estimation'],
    systemPrompt: `你是一个专业的任务规划助手。你的职责是:
1. 分析用户的复杂需求
2. 将任务分解为原子化、可执行的步骤
3. 识别步骤之间的依赖关系
4. 标记每个步骤需要在本地还是云端执行
5. 估算每个步骤的资源需求

输出格式要求 JSON 结构化计划。`,
    modelConfig: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 8000,
      temperature: 0.3,
    },
    tools: ['analyze_codebase', 'estimate_complexity'],
  },

  coder: {
    id: 'coder',
    name: 'Coder Agent',
    role: '代码实现',
    description: '根据计划生成高质量代码',
    capabilities: ['code_generation', 'refactoring', 'bug_fixing'],
    systemPrompt: `你是一个专业的编程助手。你的职责是:
1. 根据规划步骤生成代码
2. 遵循项目的代码风格和规范
3. 编写清晰、可维护的代码
4. 处理边界情况和错误

你生成的代码将由本地执行器写入文件。`,
    modelConfig: {
      provider: 'deepseek',
      model: 'deepseek-coder',
      maxTokens: 16000,
      temperature: 0.2,
    },
    tools: [],  // Coder 只生成代码，不执行工具
  },

  reviewer: {
    id: 'reviewer',
    name: 'Reviewer Agent',
    role: '代码审查',
    description: '审查代码质量、安全性和最佳实践',
    capabilities: ['code_review', 'security_audit', 'performance_analysis'],
    systemPrompt: `你是一个专业的代码审查助手。你的职责是:
1. 检查代码质量和可读性
2. 识别潜在的 bug 和安全漏洞
3. 验证是否遵循最佳实践
4. 提供改进建议`,
    modelConfig: {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      maxTokens: 8000,
      temperature: 0.4,
    },
    tools: ['analyze_code', 'check_security'],
  },

  researcher: {
    id: 'researcher',
    name: 'Researcher Agent',
    role: '技术研究',
    description: '搜索文档、最佳实践和解决方案',
    capabilities: ['documentation_search', 'best_practice_lookup', 'solution_research'],
    systemPrompt: `你是一个专业的技术研究助手。你的职责是:
1. 搜索相关技术文档和最佳实践
2. 分析类似问题的解决方案
3. 提供技术建议和参考
4. 总结研究发现

你可以访问向量数据库进行语义搜索。`,
    modelConfig: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 4000,
      temperature: 0.5,
    },
    tools: ['semantic_search', 'web_fetch'],
  },
};
```

### 多代理调度流程

```
用户请求 → Planner 分解任务
              ↓
         并行分配给专业 Agent
              ↓
         各 Agent 独立执行
              ↓
         Reviewer 审查结果
              ↓
         汇总返回用户
```

---

## 跨设备任务续接

### 设计原理

- 每个任务关联 `device_id`（创建设备）
- 任务可标记为 `transferable`（可转移）
- 新设备上线时拉取可续接任务

### 续接条件

```typescript
// 可续接条件
{
  status: 'processing',
  device_id: originalDeviceId,  // 原设备
  transferable: true,
  last_heartbeat: { $lt: 5分钟前 }  // 原设备超时
}
```

### 续接流程

```
设备 A 创建任务 → 云端开始执行 → 设备 A 离线
                                      ↓
设备 B 上线 → 检测到可续接任务 → 接管本地执行步骤
                                      ↓
                               继续任务直到完成
```

---

## 代际能力增强映射

| 代际 | 新增云端能力 |
|------|--------------|
| Gen5 | 云端向量存储、跨项目记忆 |
| Gen6 | 云端 Screenshot 分析 |
| Gen7 | 多代理云端调度 |
| Gen8 | 策略学习和优化 |

---

## 安全考虑

### API Key 权限系统

```
┌─────────────────────────────────────────────────────────────────┐
│                    API Key 权限模型                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   管理员用户                     普通用户                        │
│   ──────────                     ────────                        │
│   ┌─────────────┐               ┌─────────────┐                 │
│   │ 系统 Key    │ ← 优先       │ 用户 Key    │ ← 唯一来源      │
│   │ (环境变量)  │               │ (数据库)    │                 │
│   ├─────────────┤               └─────────────┘                 │
│   │ 用户 Key    │ ← 回退                                        │
│   │ (数据库)    │                                               │
│   └─────────────┘                                               │
│                                                                  │
│   未登录用户 → 401 拒绝访问                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**实现位置**: `cloud-agent/lib/apiKeys.ts`

```typescript
// 管理员判断
function isAdmin(user: User): boolean {
  return user.role === 'admin' || ADMIN_EMAILS.includes(user.email);
}

// Key 获取逻辑
async function getApiKey(userId: string, keyType: ApiKeyType) {
  if (isAdmin(user)) {
    // 管理员：优先系统 Key
    const systemKey = process.env[`${keyType.toUpperCase()}_API_KEY`];
    if (systemKey) return { key: systemKey, source: 'system' };
  }
  // 所有用户：查询自己配置的 Key
  return getUserConfiguredKey(userId, keyType);
}
```

### 其他安全措施

1. **用户 API Key 隔离**: 每个用户使用自己的 API Key，云端不存储明文
2. **数据加密**: 敏感数据传输使用 TLS，存储使用 AES-256
3. **访问控制**: RLS 策略确保用户只能访问自己的数据
4. **审计日志**: 所有云端操作记录审计日志
5. **超时保护**: 任务默认 1 小时超时，防止资源滥用

---

## 文件结构

### 客户端 Orchestrator（v0.6.4 实现）

```
src/main/orchestrator/
├── types.ts                    # 核心类型定义
├── index.ts                    # 模块导出入口
├── UnifiedOrchestrator.ts      # 统一指挥家（核心协调）
├── ExecutionRouter.ts          # 执行路由器（4 层优先级决策）
├── TaskAnalyzer.ts             # 任务分析器（5 维度特征提取）
├── LocalExecutor.ts            # 本地执行器
├── CloudExecutor.ts            # 云端执行器
├── CheckpointManager.ts        # 断点续传管理（v0.6.1）
├── RealtimeChannel.ts          # WebSocket 实时通信（v0.6.1）
├── agents/                     # 多 Agent 调度系统（v0.6.2）
│   ├── index.ts
│   ├── types.ts               # Agent 角色和能力定义
│   ├── AgentRegistry.ts       # Agent 注册表
│   ├── AgentExecutor.ts       # Agent 执行器
│   └── AgentScheduler.ts      # 调度器（4 种调度策略）
└── strategy/                   # 策略演进系统（v0.6.2）
    ├── index.ts
    ├── types.ts               # 策略类型定义
    ├── StrategyManager.ts     # 策略管理（支持用户反馈学习）
    └── StrategySyncer.ts      # 云端同步（冲突检测）

src/main/cloud/
├── TaskRouter.ts           # 任务路由器
├── CloudClient.ts          # 云端客户端
├── CloudTaskService.ts     # 任务服务
├── HybridTaskCoordinator.ts # 混合任务协调器
└── SyncEngine.ts           # 同步引擎
```

### 云端配置服务（v0.7.22 实现）

```
src/main/services/cloud/
├── CloudConfigService.ts     # 云端配置拉取与缓存
├── FeatureFlagService.ts     # Feature Flags 便捷函数
└── builtinConfig.ts          # 内置离线配置

vercel-api/api/v1/
└── config.ts                 # 云端配置 API
```

**CloudConfigService 功能**：
- 启动时异步拉取配置（不阻塞窗口创建）
- 1 小时缓存 + ETag 支持（304 Not Modified）
- 拉取失败静默降级到内置配置
- IPC 接口：`CLOUD_CONFIG_REFRESH`、`CLOUD_CONFIG_GET_INFO`

**云端配置内容**：
| 字段 | 说明 |
|------|------|
| prompts | 各代际 System Prompt |
| skills | Skill 定义 |
| toolMeta | 工具描述和参数 |
| featureFlags | 功能开关 |
| uiStrings | UI 文案（中/英） |
| rules | Agent 规则 |

**Feature Flags**：
| Flag | 说明 |
|------|------|
| enableGen8 | 是否启用 Gen8 |
| enableComputerUse | 是否启用 Computer Use |
| enableCloudAgent | 是否启用云端 Agent |
| maxIterations | Agent 最大迭代次数 |

### 云端 API（v0.6.0 实现）

```
vercel-api/
├── api/
│   ├── agent.ts            # Agent API (chat/plan)
│   ├── health.ts           # 健康检查
│   ├── update.ts           # 版本更新
│   └── tools/
│       ├── cloud-search.ts # DuckDuckGo 搜索
│       ├── cloud-scrape.ts # 网页抓取
│       ├── cloud-api.ts    # 通用 API 调用
│       └── cloud-memory.ts # 向量存储
├── lib/
│   ├── agent/
│   │   ├── CloudAgentLoop.ts  # 云端 Agent 循环
│   │   └── ModelClient.ts     # 多模型客户端抽象
│   ├── tools/
│   │   └── CloudToolRegistry.ts # 工具注册表
│   ├── apiKeys.ts          # API Key 权限管理
│   ├── auth.ts             # 认证
│   ├── db.ts               # 数据库连接
│   ├── middleware.ts       # 中间件
│   └── rateLimit.ts        # 速率限制
└── vercel.json             # Vercel 配置
```

### 待实现

```
cloud-agent/api/
├── agents/
│   ├── planner.ts          # 规划 Agent（Phase 4）
│   ├── coder.ts            # 编码 Agent（Phase 4）
│   ├── reviewer.ts         # 审查 Agent（Phase 4）
│   └── researcher.ts       # 研究 Agent（Phase 4）
└── scheduler/
    └── index.ts            # 多代理调度器（Phase 4）
```

---

## Orchestrator 核心模块详解

> v0.6.1 - v0.6.4 新增

### UnifiedOrchestrator（统一指挥家）

系统的核心协调中心，负责：
- 接收用户请求（`execute()` / `executeStream()`）
- 协调任务分析、路由、执行三个阶段
- 选择执行位置（本地/云端/混合）
- 管理执行历史和状态监控
- 发送事件流（analysis:start/complete, routing:start/complete, execution:*）

```typescript
// 执行流程
用户请求 → TaskAnalyzer → ExecutionRouter → LocalExecutor/CloudExecutor
              ↓                  ↓                    ↓
          任务特征分析      路由决策（4层）        执行并返回结果
```

### TaskAnalyzer（任务分析器）

深度分析用户请求，提取 5 个维度的特征：

| 维度 | 可选值 | 说明 |
|------|--------|------|
| 任务类型 | research, coding, automation, data, general | 基于关键词匹配 |
| 所需能力 | file_access, shell, network, browser, memory, code_analysis, planning | 决定执行位置 |
| 敏感度 | sensitive > internal > public | 敏感数据强制本地 |
| 复杂度 | simple < moderate < complex | 基于词数和步骤数 |
| 实时性 | realtime > async > batch | 影响执行策略 |

### ExecutionRouter（执行路由器）

4 层优先级决策：

| 优先级 | 规则类型 | 示例 |
|--------|----------|------|
| P1 | 安全规则 | 敏感数据 → 强制本地 |
| P2 | 能力约束 | file_access/shell → local_only |
| P3 | 效率优化 | 复杂任务 → hybrid，长任务 → cloud |
| P4 | 用户偏好 | 省电模式 → 优先云端 |

### CheckpointManager（断点续传）

支持任务中断后恢复：

```typescript
// 核心功能
- createCheckpoint()      // 创建检查点
- updateProgress()        // 更新进度（自动保存，10秒周期）
- resumeCheckpoint()      // 恢复执行
- getResumableCheckpoints() // 获取可恢复任务列表
```

**存储位置**: `app.getPath('userData')/checkpoints/`

### RealtimeChannel（实时通信）

WebSocket 双向通信：

| 特性 | 说明 |
|------|------|
| 消息确认 | 带超时的 ACK 机制 |
| 心跳保活 | 30 秒周期 |
| 自动重连 | 指数退避，最多 5 次 |
| 消息缓冲 | 断线期间缓存消息 |

**消息类型**: task:start, task:progress, task:chunk, task:complete, task:error, task:cancel, sync:request, sync:response

### AgentScheduler（多 Agent 调度）

7 种 Agent 角色：

| 角色 | 职责 |
|------|------|
| planner | 任务分解和规划 |
| researcher | 信息检索和研究 |
| coder | 代码生成 |
| reviewer | 代码审查 |
| writer | 文档编写 |
| tester | 测试执行 |
| coordinator | 任务协调 |

4 种调度策略：
- `round_robin`: 轮询分配
- `least_busy`: 最空闲优先
- `skill_match`: 技能匹配
- `priority_first`: 优先级优先

### StrategyManager（策略演进）

支持 5 种策略类型：
- routing: 路由策略
- execution: 执行策略
- tool_selection: 工具选择
- agent_selection: Agent 选择
- error_handling: 错误处理

**学习机制**：
1. 收集用户反馈（positive/negative/neutral）
2. 自动调整规则权重和优先级
3. 生成新规则
4. 跨用户聚合学习（可配置隐私等级）
