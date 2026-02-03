# RFC-002: 混合式多 Agent 架构

> 状态：草案
> 作者：Claude
> 创建日期：2026-02-03
> 依赖：RFC-001（子代理简化）

## 背景

基于对 Kimi Agent Swarm、AutoGen、CrewAI、LangGraph、Swarm 等框架的深入研究，以及 TDAG、MCP-Zero、MegaAgent 等学术前沿的分析，我们发现：

1. **预定义角色 vs 动态角色**不是非此即彼的选择
2. **混合架构**（静态骨架 + 动态执行）是行业最佳实践
3. **Kimi 的 100 Agent** 是动态生成的，而非 100 个预定义角色

## 目标

将 Code Agent 从"预定义角色"范式演进为"混合架构"：

```
当前：17 个预定义角色 + 静态选择
目标：4 个核心角色 + 动态扩展 + 智能路由
```

## 架构设计

### 1. 三层混合架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: 静态骨架（4 个核心角色）                                   │
│  ┌─────────┬─────────┬─────────┬─────────┐                         │
│  │  coder  │ reviewer│ explore │  plan   │                         │
│  └─────────┴─────────┴─────────┴─────────┘                         │
│  特点：边界清晰，覆盖 80% 场景，配置简单                              │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: 动态扩展（按需生成）                                       │
│                                                                     │
│  用户任务 → 模型分析 → 动态生成专用 Agent                            │
│                                                                     │
│  示例：                                                              │
│  "设计数据库 schema" → 生成 db-designer Agent                       │
│  "优化 SQL 性能" → 生成 sql-optimizer Agent                         │
│  "处理 100 个 PDF" → 生成 3 个并行 pdf-processor Agent              │
│                                                                     │
│  特点：无需预定义，模型即时决定，支持并行                             │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: 智能路由（决策层）                                         │
│                                                                     │
│  路由决策树：                                                        │
│  ├─ 简单任务 → 直接分配核心角色                                      │
│  ├─ 中等任务 → 核心角色 + 条件扩展                                   │
│  └─ 复杂任务 → 动态生成 Agent 集群                                   │
│                                                                     │
│  特点：自动判断，减少用户干预                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2. 核心角色定义（Layer 1）

| ID | 名称 | 职责 | 工具 | 模型 |
|----|------|------|------|------|
| `coder` | Coder | 编码 + 调试 + 文档 | 完整读写 | powerful |
| `reviewer` | Reviewer | 审查 + 测试 | 完整读写 | balanced |
| `explore` | Explorer | 搜索（只读）| 只读 + 网络 | fast |
| `plan` | Planner | 规划 + 架构 | 只读 + 写文档 | balanced |

**别名映射（向后兼容）**：
```typescript
const CORE_ALIASES = {
  // 旧角色 → 核心角色
  'debugger': 'coder',
  'documenter': 'coder',
  'tester': 'reviewer',
  'architect': 'plan',
  'code-explore': 'explore',
  'web-search': 'explore',
  // ...
};
```

### 3. 动态扩展机制（Layer 2）

#### 3.1 触发条件

```typescript
function shouldDynamicExpand(task: string, analysis: TaskAnalysis): boolean {
  // 条件 1：核心角色无法覆盖
  if (analysis.taskType === 'specialized') return true;

  // 条件 2：需要多个并行 Agent
  if (analysis.parallelism > 1) return true;

  // 条件 3：复杂度极高
  if (analysis.complexity === 'complex' && analysis.estimatedSteps > 20) return true;

  return false;
}
```

#### 3.2 动态 Agent 生成（LangGraph Send 风格）

```typescript
interface DynamicAgentSpec {
  name: string;           // 模型生成的角色名
  prompt: string;         // 模型生成的 system prompt
  tools: string[];        // 根据任务自动分配
  parentTask: string;     // 父任务 ID
}

async function generateDynamicAgents(
  task: string,
  context: ExecutionContext
): Promise<DynamicAgentSpec[]> {
  // 让模型分析任务，决定需要哪些专用 Agent
  const analysis = await model.analyze(`
    任务：${task}

    请分析此任务，决定需要哪些专用 Agent：

    输出 JSON：
    {
      "agents": [
        {
          "name": "角色名称（如 db-designer）",
          "responsibility": "职责描述",
          "tools_needed": ["需要的工具"],
          "can_parallel": true/false
        }
      ],
      "execution_order": "parallel" | "sequential" | "mixed"
    }
  `);

  return analysis.agents.map(spec => ({
    name: spec.name,
    prompt: buildDynamicPrompt(spec),
    tools: resolveDynamicTools(spec.tools_needed),
    parentTask: context.taskId,
  }));
}
```

#### 3.3 并行执行（Kimi 风格稀疏汇报）

```typescript
interface AgentSwarmConfig {
  maxAgents: number;      // 最大 Agent 数（默认 10，上限 50）
  reportingMode: 'sparse' | 'full';  // 汇报模式
  conflictResolution: 'coordinator' | 'vote';  // 冲突解决
}

async function executeAgentSwarm(
  agents: DynamicAgentSpec[],
  config: AgentSwarmConfig
): Promise<SwarmResult> {
  // 并行执行
  const results = await Promise.all(
    agents.map(agent => executeAgent(agent, {
      reportingMode: config.reportingMode,
      onKeyPoint: (point) => coordinator.receive(agent.name, point),
    }))
  );

  // 协调器汇总
  return coordinator.aggregate(results);
}
```

### 4. 智能路由（Layer 3）

#### 4.1 路由决策树

```typescript
type RoutingDecision =
  | { type: 'core'; agent: CoreAgentId }
  | { type: 'expand'; agents: DynamicAgentSpec[] }
  | { type: 'swarm'; config: AgentSwarmConfig };

function routeTask(task: string, analysis: TaskAnalysis): RoutingDecision {
  // Level 1: 简单任务 → 直接核心角色
  if (analysis.complexity === 'simple') {
    return {
      type: 'core',
      agent: mapToCore(analysis.taskType),
    };
  }

  // Level 2: 中等任务 → 核心 + 条件扩展
  if (analysis.complexity === 'moderate') {
    if (shouldDynamicExpand(task, analysis)) {
      return {
        type: 'expand',
        agents: await generateDynamicAgents(task, context),
      };
    }
    return {
      type: 'core',
      agent: mapToCore(analysis.taskType),
    };
  }

  // Level 3: 复杂任务 → Agent Swarm
  return {
    type: 'swarm',
    config: {
      maxAgents: Math.min(analysis.parallelism * 2, 50),
      reportingMode: 'sparse',
      conflictResolution: 'coordinator',
    },
  };
}
```

#### 4.2 任务复杂度评估

```typescript
interface TaskAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  taskType: 'code' | 'analysis' | 'research' | 'design' | 'mixed';
  parallelism: number;      // 可并行子任务数
  estimatedSteps: number;   // 预估步骤数
  specializations: string[]; // 需要的专业能力
}

function analyzeTask(task: string): TaskAnalysis {
  // 信号词检测
  const complexIndicators = [
    '全面', '详细', '完整', '重构', '设计', '分析',
    'comprehensive', 'detailed', 'refactor', 'design', 'analyze'
  ];

  // 并行性检测
  const parallelIndicators = [
    /(\d+)\s*(个|份|批)/,  // "100 份 PDF"
    /并行|parallel|同时|concurrent/,
  ];

  // 专业化检测
  const specializationPatterns = {
    'database': /数据库|SQL|schema|migration/i,
    'frontend': /React|Vue|CSS|UI|组件/i,
    'backend': /API|服务|接口|后端/i,
    'devops': /部署|CI|CD|Docker|K8s/i,
  };

  // ... 评估逻辑
}
```

### 5. 配置简化

#### 5.1 新配置接口

```typescript
// 核心角色：最简配置
interface CoreAgentConfig {
  id: 'coder' | 'reviewer' | 'explore' | 'plan';
  model: 'fast' | 'balanced' | 'powerful';
}

// 动态角色：运行时生成
interface DynamicAgentConfig {
  name: string;
  prompt: string;
  tools: string[];
  ttl?: number;  // 生命周期（默认任务结束即销毁）
}

// Swarm 配置
interface SwarmConfig {
  maxAgents: number;
  reportingMode: 'sparse' | 'full';
}
```

#### 5.2 配置层级

```yaml
# .code-agent/agents.yaml（可选覆盖）
core:
  coder:
    model: powerful
  explore:
    model: fast

dynamic:
  enabled: true
  max_agents: 10

swarm:
  enabled: true
  max_agents: 50
  reporting_mode: sparse
```

## 实施计划

### Phase 1: 简化核心角色（1 周）

- [ ] 实施 RFC-001（17 → 8 → 4 核心 + 4 扩展）
- [ ] 重构 `agentDefinition.ts`
- [ ] 添加别名映射
- [ ] 更新测试

### Phase 2: 引入动态扩展（2 周）

- [ ] 实现 `DynamicAgentFactory`
- [ ] 实现任务分析器增强
- [ ] 实现动态 Prompt 生成
- [ ] 添加动态工具分配

### Phase 3: 实现智能路由（1 周）

- [ ] 实现 `TaskRouter`
- [ ] 实现复杂度评估
- [ ] 集成到 AgentLoop

### Phase 4: Agent Swarm 支持（2 周）

- [ ] 实现并行执行引擎
- [ ] 实现稀疏汇报协议
- [ ] 实现协调器（冲突检测、结果聚合）
- [ ] 压力测试

## 度量指标

### 简化效果

| 指标 | 当前 | Phase 1 | Phase 4 |
|------|------|---------|---------|
| 预定义角色数 | 17 | 4+4 | 4 核心 |
| 配置字段数 | ~30 | 8 | 5 |
| 代码行数 | ~900 | ~400 | ~600 |

### 动态能力

| 指标 | 当前 | Phase 4 |
|------|------|---------|
| 动态角色支持 | ❌ | ✅ |
| 并行 Agent 数 | 1 | 50 |
| 任务覆盖率 | ~80% | ~95% |

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 动态 Agent 质量不稳定 | 中 | 中 | Prompt 模板 + 验证 |
| 并行冲突 | 中 | 高 | 资源锁 + 协调器 |
| 成本增加 | 中 | 中 | 智能路由优先核心角色 |

## 参考资料

- [Kimi K2.5 Agent Swarm 技术分析](https://www.stcn.com/article/detail/3616521.html)
- [LangGraph Send API](https://langchain.com/langgraph)
- [OpenAI Swarm Handoff](https://github.com/openai/swarm)
- [TDAG: 动态任务分解](https://arxiv.org/html/2402.10178v2)
- [MCP-Zero: 主动工具发现](https://arxiv.org/html/2506.01056v3)
