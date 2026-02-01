# 子代理系统优化计划

> 基于大厂实践研究，优化 code-agent 子代理执行效率

## 问题概述

| 问题 | 严重程度 | 影响 |
|------|----------|------|
| 参数格式错误 | Critical | 子代理调用 100% 失败 |
| 重复派发任务 | High | 浪费 2-3x 时间和 tokens |
| 迭代次数失控 | Medium | 执行时间差异 3-4x |
| 缺少执行时间限制 | Medium | 可能导致超时 |

## 改造优先级

```
P0: 参数验证与结构化输出   → 确保调用成功
P1: 任务去重机制          → 避免重复执行
P2: 迭代次数分级控制       → 资源合理分配
P3: 执行时间限制          → 防止超时
P4: 子代理模型路由         → 成本和速度优化
```

---

## P0: 参数验证与结构化输出

### 目标
确保 task 工具参数格式正确，消除 `subagent_type: undefined` 错误

### 方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| A: 结构化输出 | 从源头杜绝错误 | 需要模型支持 | OpenAI/Claude |
| B: 后验证+重试 | 通用性强 | 消耗额外 tokens | 所有模型 |
| C: 参数修复 | 兼容性好 | 可能修复错误 | 作为补充 |

### 实施方案：B + C 组合

**文件**: `src/main/tools/multiagent/task.ts`

```typescript
// 第 62-79 行区域，增强参数验证

interface TaskParams {
  subagent_type: string;
  prompt: string;
  description?: string;
}

function parseAndValidateTaskParams(params: Record<string, unknown>): TaskParams | { error: string } {
  // 1. 提取参数（处理各种格式问题）
  let subagentType = params.subagent_type as string;
  let prompt = params.prompt as string;

  // 2. 修复常见格式错误
  if (typeof subagentType === 'string') {
    // 移除可能混入的 XML/HTML 标签
    subagentType = subagentType.replace(/<[^>]*>/g, '').trim();
    // 移除引号
    subagentType = subagentType.replace(/^["']|["']$/g, '');
  }

  // 3. 验证必需参数
  const validTypes = ['explore', 'code-review', 'plan', 'bash', 'coder', 'reviewer', ...];
  if (!subagentType || !validTypes.includes(subagentType)) {
    return {
      error: `Invalid subagent_type: "${subagentType}". Valid types: ${validTypes.join(', ')}`
    };
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: 'Missing or empty prompt parameter' };
  }

  return { subagent_type: subagentType, prompt: prompt.trim(), description: params.description as string };
}
```

### 测试用例

```typescript
// 正常参数
{ subagent_type: 'code-review', prompt: '审查代码' } // ✓

// 格式错误参数（需要修复）
{ 'subagent_type="code-review</arg_value>': '...' } // 修复后 ✓

// 无效类型
{ subagent_type: 'invalid', prompt: '...' } // 返回错误
```

---

## P1: 任务去重机制

### 目标
避免重复派发相同任务，借鉴 Anthropic 的进度追踪机制

### 设计

**文件**: 新建 `src/main/agent/taskDeduplication.ts`

```typescript
/**
 * 任务去重管理器
 *
 * 借鉴 Anthropic: "maintain a JSON file with detailed feature requirements"
 */

interface DispatchedTask {
  hash: string;           // prompt 的哈希摘要
  subagentType: string;
  promptPreview: string;  // 前 100 字符
  dispatchTime: number;
  status: 'running' | 'completed' | 'failed';
  result?: string;        // 缓存结果
}

class TaskDeduplicationManager {
  private dispatchedTasks = new Map<string, DispatchedTask>();
  private readonly MAX_CACHE_SIZE = 50;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

  /**
   * 计算任务哈希
   */
  private computeTaskHash(subagentType: string, prompt: string): string {
    // 使用前 200 字符 + 类型计算哈希
    const normalized = `${subagentType}:${prompt.substring(0, 200).toLowerCase().trim()}`;
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 12);
  }

  /**
   * 检查是否重复任务
   */
  isDuplicate(subagentType: string, prompt: string): {
    isDuplicate: boolean;
    cachedResult?: string;
    reason?: string;
  } {
    const hash = this.computeTaskHash(subagentType, prompt);
    const existing = this.dispatchedTasks.get(hash);

    if (!existing) {
      return { isDuplicate: false };
    }

    // 检查是否过期
    if (Date.now() - existing.dispatchTime > this.CACHE_TTL_MS) {
      this.dispatchedTasks.delete(hash);
      return { isDuplicate: false };
    }

    // 正在运行的任务
    if (existing.status === 'running') {
      return {
        isDuplicate: true,
        reason: `相同任务正在执行中 (${existing.promptPreview}...)`
      };
    }

    // 已完成的任务，返回缓存结果
    if (existing.status === 'completed' && existing.result) {
      return {
        isDuplicate: true,
        cachedResult: existing.result,
        reason: '使用缓存结果'
      };
    }

    return { isDuplicate: false };
  }

  /**
   * 注册新任务
   */
  registerTask(subagentType: string, prompt: string): string {
    const hash = this.computeTaskHash(subagentType, prompt);
    this.dispatchedTasks.set(hash, {
      hash,
      subagentType,
      promptPreview: prompt.substring(0, 100),
      dispatchTime: Date.now(),
      status: 'running'
    });

    // 清理旧缓存
    this.cleanup();

    return hash;
  }

  /**
   * 更新任务状态
   */
  completeTask(hash: string, result: string): void {
    const task = this.dispatchedTasks.get(hash);
    if (task) {
      task.status = 'completed';
      task.result = result.substring(0, 2000); // 限制缓存大小
    }
  }

  /**
   * 清理过期缓存
   */
  private cleanup(): void {
    if (this.dispatchedTasks.size <= this.MAX_CACHE_SIZE) return;

    const now = Date.now();
    for (const [hash, task] of this.dispatchedTasks) {
      if (now - task.dispatchTime > this.CACHE_TTL_MS) {
        this.dispatchedTasks.delete(hash);
      }
    }
  }
}

export const taskDeduplication = new TaskDeduplicationManager();
```

### 集成到 task.ts

```typescript
// task.ts execute 函数开头
import { taskDeduplication } from '../agent/taskDeduplication';

// 检查重复
const dupCheck = taskDeduplication.isDuplicate(subagentType, prompt);
if (dupCheck.isDuplicate) {
  if (dupCheck.cachedResult) {
    return { output: `[缓存结果] ${dupCheck.cachedResult}` };
  }
  return { output: dupCheck.reason || '任务已在执行中，请等待' };
}

// 注册任务
const taskHash = taskDeduplication.registerTask(subagentType, prompt);

// ... 执行子代理 ...

// 完成时更新
taskDeduplication.completeTask(taskHash, result.output);
```

---

## P2: 迭代次数分级控制

### 目标
借鉴 Anthropic 的资源分配规则，根据任务复杂度动态分配迭代次数

### Anthropic 规则

| 任务类型 | 子代理数 | 工具调用/代理 | 总迭代预算 |
|----------|---------|--------------|-----------|
| 简单查询 | 1 | 3-10 | 10 |
| 直接比较 | 2-4 | 10-15 | 40-60 |
| 复杂研究 | 10+ | 按职责分配 | 100+ |

### 实施方案

**文件**: `src/main/agent/agentDefinition.ts`

```typescript
/**
 * 动态迭代次数计算
 *
 * 借鉴 Anthropic: "embedded scaling rules in prompts"
 */
export function calculateMaxIterations(
  agentType: string,
  taskComplexity: 'simple' | 'moderate' | 'complex',
  promptLength: number
): number {
  // 基础迭代次数（从 PREDEFINED_AGENTS 获取）
  const agent = getPredefinedAgent(agentType);
  const baseIterations = agent?.maxIterations || 10;

  // 复杂度调整因子
  const complexityFactor = {
    simple: 0.5,    // 简单任务减半
    moderate: 1.0,  // 中等任务不变
    complex: 1.5    // 复杂任务增加 50%
  }[taskComplexity];

  // Prompt 长度调整（长 prompt 可能需要更多迭代）
  const lengthFactor = Math.min(1.5, 1 + (promptLength - 200) / 1000);

  // 计算最终值，设置上下限
  const calculated = Math.round(baseIterations * complexityFactor * lengthFactor);

  return Math.max(3, Math.min(calculated, 30)); // 范围: 3-30
}

/**
 * 估算任务复杂度
 */
export function estimateTaskComplexity(prompt: string): 'simple' | 'moderate' | 'complex' {
  const indicators = {
    simple: ['查找', '读取', '列出', 'find', 'list', 'read', 'get'],
    complex: ['分析', '审计', '重构', '设计', 'analyze', 'audit', 'refactor', 'design', '全面', '详细']
  };

  const lowerPrompt = prompt.toLowerCase();

  // 检查复杂指标
  const hasComplexIndicator = indicators.complex.some(i => lowerPrompt.includes(i));
  const hasMultipleTasks = (prompt.match(/\d+\./g) || []).length >= 3;

  if (hasComplexIndicator || hasMultipleTasks) return 'complex';

  // 检查简单指标
  const hasSimpleIndicator = indicators.simple.some(i => lowerPrompt.includes(i));
  if (hasSimpleIndicator && prompt.length < 100) return 'simple';

  return 'moderate';
}
```

### 更新 Agent 定义

```typescript
// agentDefinition.ts - 更新 PREDEFINED_AGENTS

// 调整各类型 Agent 的默认 maxIterations
const ITERATION_LIMITS = {
  // 信息搜集类（快速返回）
  'explore': 8,        // 原 25 → 8
  'code-explore': 8,
  'doc-reader': 6,

  // 分析审查类（适中）
  'code-review': 12,   // 原 20 → 12
  'reviewer': 12,

  // 执行类（可能需要更多）
  'coder': 15,         // 原 25 → 15
  'debugger': 15,      // 原 30 → 15

  // 规划类（限制思考时间）
  'plan': 10,          // 原 20 → 10
  'architect': 10,     // 原 15 → 10
};
```

---

## P3: 执行时间限制

### 目标
防止单个子代理执行时间过长导致整体超时

### 设计

**文件**: `src/main/agent/subagentExecutor.ts`

```typescript
// 添加执行超时机制

interface SubagentConfig {
  // ... 现有字段 ...
  maxExecutionTimeMs?: number; // 新增
}

// 默认超时配置
const DEFAULT_EXECUTION_TIMEOUT = {
  'explore': 30_000,       // 30 秒
  'code-review': 60_000,   // 60 秒
  'coder': 90_000,         // 90 秒
  'default': 60_000        // 默认 60 秒
};

async execute(task: string, config: SubagentConfig, ...): Promise<SubagentResult> {
  const timeout = config.maxExecutionTimeMs ||
    DEFAULT_EXECUTION_TIMEOUT[config.name] ||
    DEFAULT_EXECUTION_TIMEOUT.default;

  const startTime = Date.now();

  // 在迭代循环中检查超时
  while (iterations < maxIterations) {
    // 超时检查
    if (Date.now() - startTime > timeout) {
      logger.warn(`[SubAgent] Execution timeout after ${timeout}ms`, {
        agentName: config.name,
        iterations
      });
      return {
        success: false,
        output: `执行超时 (${Math.round(timeout/1000)}秒)，已完成 ${iterations} 次迭代`,
        error: 'EXECUTION_TIMEOUT',
        iterations,
        toolsUsed
      };
    }

    // ... 正常迭代逻辑 ...
  }
}
```

---

## 实施计划

### Phase 1: P0 参数验证 (1 天)

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1.1 | `task.ts` | 添加 `parseAndValidateTaskParams()` 函数 |
| 1.2 | `task.ts` | 在 execute 开头调用验证 |
| 1.3 | - | 添加单元测试 |

### Phase 2: P1 任务去重 (1 天)

| 步骤 | 文件 | 改动 |
|------|------|------|
| 2.1 | 新建 `taskDeduplication.ts` | 实现去重管理器 |
| 2.2 | `task.ts` | 集成去重检查 |
| 2.3 | - | 添加日志和测试 |

### Phase 3: P2 迭代分级 (0.5 天)

| 步骤 | 文件 | 改动 |
|------|------|------|
| 3.1 | `agentDefinition.ts` | 添加动态迭代计算函数 |
| 3.2 | `agentDefinition.ts` | 调整各 Agent 默认值 |
| 3.3 | `task.ts` | 使用动态计算值 |

### Phase 4: P3 超时限制 (0.5 天)

| 步骤 | 文件 | 改动 |
|------|------|------|
| 4.1 | `subagentExecutor.ts` | 添加超时配置和检查 |
| 4.2 | `agentDefinition.ts` | 为各 Agent 定义超时 |

### Phase 5: P4 模型路由 (0.5 天)

| 步骤 | 文件 | 改动 |
|------|------|------|
| 5.1 | `agentDefinition.ts` | 添加 `SUBAGENT_MODEL_CONFIG` 配置 |
| 5.2 | `task.ts` | 集成模型选择逻辑 |
| 5.3 | `modelRouter.ts` | 确保支持动态模型切换 |

---

## 预期效果

| 指标 | 当前 | 优化后 | 提升 |
|------|------|--------|------|
| 参数错误率 | ~10% | <1% | 90%↓ |
| 重复任务 | 2-3x | 0x | 100%↓ |
| 平均执行时间 | 60-120s | 30-60s | 50%↓ |
| 超时失败率 | ~20% | <5% | 75%↓ |
| 子代理成本 | 100% | ~30% | 70%↓ |

## 验证方法

1. **单元测试**: 参数验证、去重逻辑
2. **E2E 测试**: V06、U06 测试通过
3. **日志监控**: 检查 duration、iterations 分布
4. **Langfuse**: 跟踪 token 消耗和执行时间

---

## P4: 子代理模型路由

### 目标
根据子代理类型分配合适的模型，优化成本和速度

### Anthropic 经验

| 角色 | 推荐模型级别 | 原因 |
|------|-------------|------|
| Orchestrator | Opus/Sonnet | 需要复杂规划能力 |
| Executor | Haiku | 执行明确指令，不需要复杂推理 |
| Reviewer | Sonnet | 需要理解上下文 |

### 我们的模型策略

> **背景**：GLM-4.7 为包年套餐，边际成本为零

| 任务类型 | 推荐模型 | 原因 |
|----------|----------|------|
| 简单任务 | GLM-4-Flash | 免费，速度更快 |
| 其他所有 | GLM-4.7 | 包年已付费，稳定性好 |
| 降级备用 | DeepSeek V3 | API 不可用时 |

### 实施方案

**文件**: `src/main/agent/agentDefinition.ts`

```typescript
// 子代理模型配置（基于 GLM 包年套餐优化）
const SUBAGENT_MODEL_CONFIG = {
  // 简单任务：使用 Flash（免费且更快）
  'explore': 'glm-4-flash',
  'doc-reader': 'glm-4-flash',
  'bash-executor': 'glm-4-flash',

  // 其他任务：全部使用 GLM-4.7（包年套餐）
  'coder': 'glm-4.7',
  'reviewer': 'glm-4.7',
  'code-review': 'glm-4.7',
  'refactorer': 'glm-4.7',
  'architect': 'glm-4.7',
  'plan': 'glm-4.7',
  'debugger': 'glm-4.7',
  'tester': 'glm-4.7',
  'documenter': 'glm-4.7',
};

// 降级配置（GLM 不可用时）
const FALLBACK_MODEL = 'deepseek-chat';

/**
 * 获取子代理应使用的模型
 */
export function getSubagentModel(agentType: string): string {
  return SUBAGENT_MODEL_CONFIG[agentType] || 'deepseek-chat';
}
```

**文件**: `src/main/tools/multiagent/task.ts`

```typescript
// 在创建子代理时使用配置的模型
import { getSubagentModel } from '../../agent/agentDefinition';

// execute 函数中
const model = getSubagentModel(subagentType);
const subagent = createSubagent({
  type: subagentType,
  model: model,
  // ...
});
```

### 预期效果

| 指标 | 当前 | 优化后 |
|------|------|--------|
| 子代理边际成本 | 按量付费 | 0（包年） |
| 子代理稳定性 | 一般 | 更高（GLM-4.7）|
| Explore 任务延迟 | 30-60s | 5-15s（Flash）|
| 多文件理解准确率 | 一般 | 更高（GLM-4.7）|

---

## 参考资料

- [Anthropic Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Pydantic AI Agents](https://ai.pydantic.dev/agents/)
