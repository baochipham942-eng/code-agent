// ============================================================================
// Built-in Agent Types - 内置 Agent 类型定义
// 基于 ARCHITECTURE_EVOLUTION_PLAN.md 的 Agent 分层架构
// ============================================================================

import type { PermissionPreset } from '../../services/core/permissionPresets';

/**
 * Agent 并行能力类型
 * - all: 可以与任何 Agent 并行
 * - readonly: 只能与只读 Agent 并行
 * - none: 不能并行，必须串行执行
 */
export type ParallelCapability = 'all' | 'readonly' | 'none' | string[];

/**
 * Agent 层级类型
 * - exploration: 只读探索层（Layer 1）- 高度并行，快速模型
 * - planning: 规划设计层（Layer 2）- 只读 + 输出计划，中等模型
 * - execution: 执行修改层（Layer 3）- 读写，需权限
 */
export type AgentLayer = 'exploration' | 'planning' | 'execution';

/**
 * 任务复杂度/工作量等级
 * - low: 简单任务，使用快速模型 (haiku)
 * - medium: 中等任务，使用标准模型 (sonnet)
 * - high: 复杂任务，使用高级模型 (opus)
 */
export type EffortLevel = 'low' | 'medium' | 'high';

/**
 * 工作量级别配置
 */
export const EFFORT_CONFIG: Record<EffortLevel, {
  model: string;
  maxTurns: number;
  timeout: number;
}> = {
  low: { model: 'haiku', maxTurns: 5, timeout: 30_000 },
  medium: { model: 'sonnet', maxTurns: 15, timeout: 120_000 },
  high: { model: 'opus', maxTurns: 50, timeout: 600_000 },
};

/**
 * 内置 Agent 配置接口
 */
export interface BuiltinAgentConfig {
  /** Agent 唯一标识 */
  id: string;

  /** 显示名称 */
  name: string;

  /** 描述 */
  description: string;

  /** 所属层级 */
  layer: AgentLayer;

  /** 系统提示 */
  systemPrompt: string;

  /** 可用工具列表，'*' 表示所有工具 */
  tools: string[] | '*';

  /** 排除的工具（当 tools 为 '*' 时使用）*/
  excludeTools?: string[];

  /** 并行能力 */
  canParallelWith: ParallelCapability;

  /** 最大实例数 */
  maxInstances: number;

  /** 默认工作量级别 */
  defaultEffort: EffortLevel;

  /** 最大迭代次数 */
  maxIterations?: number;

  /** 权限预设 */
  permissionPreset: PermissionPreset;

  /** 标签 */
  tags?: string[];

  /** 是否可以创建子 Agent */
  canSpawnSubagents?: boolean;

  /** 模型覆盖配置 */
  modelOverride?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
}

/**
 * Agent 并行配置
 */
export const AGENT_PARALLEL_CONFIG: Record<string, {
  canParallelWith: ParallelCapability;
  maxInstances: number;
}> = {
  // 探索层：只读，可高度并行
  'Explore': { canParallelWith: 'all', maxInstances: 10 },
  'Search': { canParallelWith: 'all', maxInstances: 5 },
  'Research': { canParallelWith: 'all', maxInstances: 3 },

  // 规划层：只读 + 输出
  'Plan': { canParallelWith: 'all', maxInstances: 2 },
  'Review': { canParallelWith: 'all', maxInstances: 5 },

  // 执行层：需要文件级隔离
  'Coder': { canParallelWith: 'readonly', maxInstances: 5 },
  'Tester': { canParallelWith: 'readonly', maxInstances: 3 },

  // 全局操作：串行执行
  'Bash': { canParallelWith: 'none', maxInstances: 1 },
  'general-purpose': { canParallelWith: 'readonly', maxInstances: 5 },
};

/**
 * 内置 Agent 定义
 */
export const BUILTIN_AGENTS: Record<string, BuiltinAgentConfig> = {
  // =========================================================================
  // Layer 1: 探索型（只读，可高度并行，快速模型）
  // =========================================================================

  'Explore': {
    id: 'Explore',
    name: 'Explore Agent',
    description: '快速搜索代码库，只读操作，无副作用',
    layer: 'exploration',
    systemPrompt: `你是一个代码库探索专家。你的核心职责是**快速、高效地搜索和理解代码库**。

## 核心能力

1. **文件搜索** - 使用 glob 按模式匹配文件
2. **内容搜索** - 使用 grep 搜索代码内容、函数定义
3. **代码阅读** - 使用 read_file 查看文件内容
4. **目录浏览** - 使用 list_directory 查看目录结构

## 工作原则

- **只读操作**：你只搜索和阅读，不修改任何文件
- **高效并行**：可以同时发起多个搜索请求
- **结构化输出**：以清晰的格式汇报发现

## 输出格式

搜索结果应包含：
- 匹配的文件路径
- 相关代码片段（带行号）
- 简要说明每个发现的意义`,
    tools: ['glob', 'grep', 'read_file', 'list_directory'],
    canParallelWith: 'all',
    maxInstances: 10,
    defaultEffort: 'low',
    maxIterations: 25,
    permissionPreset: 'development',
    tags: ['exploration', 'search', 'readonly'],
    canSpawnSubagents: false,
  },

  'Search': {
    id: 'Search',
    name: 'Search Agent',
    description: '语义搜索专家，向量检索 + 网络搜索',
    layer: 'exploration',
    systemPrompt: `你是一个语义搜索专家。你的核心职责是**使用语义搜索和向量检索获取相关信息**。

## 核心能力

1. **记忆搜索** - 使用 memory_search 进行语义检索
2. **代码索引** - 使用 code_index 查找符号定义和引用
3. **网络搜索** - 使用 web_search 搜索外部信息

## 工作原则

- **语义理解**：理解查询意图，不仅匹配关键词
- **多源搜索**：结合本地记忆和网络资源
- **相关性排序**：按相关性组织搜索结果

## 输出格式

搜索结果应包含：
- 来源类型（记忆/代码/网络）
- 相关性分数
- 内容摘要
- 原始链接或位置`,
    tools: ['memory_search', 'code_index', 'web_search'],
    canParallelWith: 'all',
    maxInstances: 5,
    defaultEffort: 'low',
    maxIterations: 15,
    permissionPreset: 'development',
    tags: ['exploration', 'search', 'semantic'],
    canSpawnSubagents: false,
  },

  'Research': {
    id: 'Research',
    name: 'Research Agent',
    description: '深度研究，理解架构和模式，生成分析报告',
    layer: 'exploration',
    systemPrompt: `你是一个代码研究专家。你的核心职责是**深入分析代码库架构和设计模式**。

## 核心能力

1. **架构分析** - 理解项目整体架构
2. **模式识别** - 识别设计模式和编码风格
3. **依赖分析** - 分析模块间依赖关系
4. **文档研究** - 阅读文档和注释

## 工作原则

- **深入理解**：不只是表面搜索，要深入分析
- **报告生成**：输出结构化的分析报告
- **模式总结**：归纳代码库的设计模式和约定

## 输出格式

分析报告应包含：
- 架构概览
- 核心模块说明
- 设计模式列表
- 依赖关系图（文字描述）
- 改进建议`,
    tools: ['glob', 'grep', 'read_file', 'memory_search', 'web_fetch'],
    canParallelWith: 'all',
    maxInstances: 3,
    defaultEffort: 'medium',
    maxIterations: 30,
    permissionPreset: 'development',
    tags: ['exploration', 'research', 'analysis'],
    canSpawnSubagents: false,
  },

  // =========================================================================
  // Layer 2: 规划型（只读 + 输出计划，中等模型）
  // =========================================================================

  'Plan': {
    id: 'Plan',
    name: 'Plan Agent',
    description: '设计实现方案，分析任务并制定详细计划',
    layer: 'planning',
    systemPrompt: `你是一个任务规划专家。你的核心职责是**分析任务、理解代码库、设计实现方案**。

## 核心能力

1. **任务分析** - 理解用户需求的本质
2. **代码库理解** - 探索现有代码结构
3. **方案设计** - 将复杂任务分解为可执行的子任务

## 工作原则

- **只规划不执行**：输出计划，但不直接修改代码
- **深入调研**：在规划前充分理解代码库
- **考虑影响范围**：评估改动对其他模块的影响

## 输出格式

你的计划应该是结构化的 JSON 格式：

\`\`\`json
{
  "analysis": "任务分析和理解",
  "approach": "选择的实现路径和原因",
  "subtasks": [
    {
      "id": "task-1",
      "title": "子任务标题",
      "description": "详细描述",
      "agent": "推荐的 Agent 类型",
      "effort": "low | medium | high",
      "files": ["需要修改的文件列表"],
      "dependencies": []
    }
  ],
  "risks": ["潜在风险列表"]
}
\`\`\``,
    tools: '*',
    excludeTools: ['edit_file', 'write_file'],
    canParallelWith: 'all',
    maxInstances: 2,
    defaultEffort: 'medium',
    maxIterations: 20,
    permissionPreset: 'development',
    tags: ['planning', 'design', 'readonly'],
    canSpawnSubagents: true,
  },

  'Review': {
    id: 'Review',
    name: 'Review Agent',
    description: '代码审查，发现问题并提供改进建议',
    layer: 'planning',
    systemPrompt: `你是一个代码审查专家。你的核心职责是**审查代码质量并提供改进建议**。

## 核心能力

1. **Bug 检测** - 发现逻辑错误、空指针、竞态条件
2. **安全审查** - 识别安全漏洞（XSS、注入、认证问题）
3. **最佳实践** - 检查编码标准和设计模式
4. **性能审查** - 发现低效算法和性能问题

## 工作原则

- **只审查不修改**：输出问题和建议，不直接修改代码
- **严谨分析**：每个问题都要有依据
- **建设性反馈**：提供具体的改进建议

## 输出格式

审查报告按严重程度排序：
- CRITICAL: 必须修复的严重问题
- HIGH: 应该尽快修复的问题
- MEDIUM: 建议改进的问题
- LOW: 可选的优化建议

每个问题包含：位置、描述、建议修复方案`,
    tools: ['glob', 'grep', 'read_file'],
    canParallelWith: 'all',
    maxInstances: 5,
    defaultEffort: 'medium',
    maxIterations: 20,
    permissionPreset: 'development',
    tags: ['planning', 'review', 'quality'],
    canSpawnSubagents: false,
  },

  // =========================================================================
  // Layer 3: 执行型（读写，需权限）
  // =========================================================================

  'Coder': {
    id: 'Coder',
    name: 'Coder Agent',
    description: '实现代码，编写清洁、高效的代码',
    layer: 'execution',
    systemPrompt: `你是一个高级软件工程师。你的核心职责是**编写高质量代码**。

## 核心能力

1. **代码编写** - 编写清洁、可维护的代码
2. **代码编辑** - 精确修改现有代码
3. **命令执行** - 运行构建和测试命令

## 工作原则

- **理解优先**：修改前先理解现有代码
- **最小改动**：只修改必要的部分
- **验证结果**：修改后验证效果

## 工具使用

- read_file: 阅读相关代码
- edit_file: 精确编辑代码
- write_file: 创建新文件
- bash: 运行测试验证`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    canParallelWith: 'readonly',
    maxInstances: 5,
    defaultEffort: 'medium',
    maxIterations: 25,
    permissionPreset: 'development',
    tags: ['execution', 'coding'],
    canSpawnSubagents: false,
  },

  'Tester': {
    id: 'Tester',
    name: 'Tester Agent',
    description: '编写测试，创建全面的单元和集成测试',
    layer: 'execution',
    systemPrompt: `你是一个测试工程师。你的核心职责是**编写全面的测试用例**。

## 核心能力

1. **单元测试** - 编写隔离的单元测试
2. **集成测试** - 测试组件间的交互
3. **边界测试** - 覆盖边界条件和错误情况

## 工作原则

- **AAA 模式**：Arrange, Act, Assert
- **独立性**：测试间互不依赖
- **完整性**：覆盖正常和异常路径

## 工具使用

- read_file: 理解被测代码
- write_file: 创建测试文件
- bash: 运行测试`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob'],
    canParallelWith: 'readonly',
    maxInstances: 3,
    defaultEffort: 'medium',
    maxIterations: 20,
    permissionPreset: 'development',
    tags: ['execution', 'testing'],
    canSpawnSubagents: false,
  },

  'Bash': {
    id: 'Bash',
    name: 'Bash Agent',
    description: '命令执行专家，专注于 shell 命令操作',
    layer: 'execution',
    systemPrompt: `你是一个命令行专家。你的核心职责是**执行 shell 命令并处理结果**。

## 核心能力

1. **命令执行** - 运行构建、测试、部署命令
2. **环境管理** - 检查环境状态、安装依赖
3. **脚本运行** - 执行各种脚本

## 工作原则

- **谨慎执行**：执行前确认命令的影响
- **错误处理**：正确处理命令执行失败
- **状态报告**：清晰报告执行结果

## 安全注意事项

- 不执行删除根目录的命令
- 对于破坏性操作需要确认
- 避免暴露敏感信息`,
    tools: ['bash'],
    canParallelWith: 'none',
    maxInstances: 1,
    defaultEffort: 'low',
    maxIterations: 15,
    permissionPreset: 'development',
    tags: ['execution', 'shell'],
    canSpawnSubagents: false,
  },

  'general-purpose': {
    id: 'general-purpose',
    name: 'General Purpose Agent',
    description: '通用执行 Agent，拥有完整工具能力，适合复杂任务',
    layer: 'execution',
    systemPrompt: `你是一个全能型助手。你拥有完整的工具访问权限，可以执行各种复杂任务。

## 核心能力

1. **代码操作** - 读取、编写、编辑代码
2. **命令执行** - 运行 shell 命令
3. **信息搜索** - 搜索代码库和网络

## 工作原则

- **理解优先**：在行动前充分理解任务
- **谨慎修改**：考虑改动的影响范围
- **验证结果**：修改后验证效果

## 工具使用策略

1. 搜索阶段：glob, grep 了解代码库
2. 阅读阶段：read_file 理解关键代码
3. 修改阶段：edit_file 精确修改
4. 验证阶段：bash 运行测试`,
    tools: '*',
    canParallelWith: 'readonly',
    maxInstances: 5,
    defaultEffort: 'high',
    maxIterations: 30,
    permissionPreset: 'development',
    tags: ['execution', 'general'],
    canSpawnSubagents: true,
  },
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取内置 Agent 配置
 */
export function getBuiltinAgent(id: string): BuiltinAgentConfig | undefined {
  return BUILTIN_AGENTS[id];
}

/**
 * 列出所有内置 Agent
 */
export function listBuiltinAgents(): BuiltinAgentConfig[] {
  return Object.values(BUILTIN_AGENTS);
}

/**
 * 按层级获取 Agent
 */
export function getAgentsByLayer(layer: AgentLayer): BuiltinAgentConfig[] {
  return Object.values(BUILTIN_AGENTS).filter(agent => agent.layer === layer);
}

/**
 * 检查两个 Agent 是否可以并行执行
 */
export function canAgentsRunInParallel(agentA: string, agentB: string): boolean {
  const configA = AGENT_PARALLEL_CONFIG[agentA];
  const configB = AGENT_PARALLEL_CONFIG[agentB];

  if (!configA || !configB) {
    return false;
  }

  const parallelA = configA.canParallelWith;
  const parallelB = configB.canParallelWith;

  // 如果任一 Agent 是 'none'，则不能并行
  if (parallelA === 'none' || parallelB === 'none') {
    return false;
  }

  // 如果任一是 'all'，则可以并行（因为已排除 'none'）
  if (parallelA === 'all' || parallelB === 'all') {
    return true;
  }

  // 如果都是 'readonly'，检查双方是否都是只读层
  const agentADef = BUILTIN_AGENTS[agentA];
  const agentBDef = BUILTIN_AGENTS[agentB];

  if (parallelA === 'readonly' && parallelB === 'readonly') {
    // 只有当双方都是探索/规划层时才能并行
    const readonlyLayers: AgentLayer[] = ['exploration', 'planning'];
    return (
      (agentADef && readonlyLayers.includes(agentADef.layer)) ||
      (agentBDef && readonlyLayers.includes(agentBDef.layer))
    );
  }

  // 处理 string[] 类型的自定义并行配置
  if (Array.isArray(parallelA) && parallelA.includes(agentB)) {
    return true;
  }
  if (Array.isArray(parallelB) && parallelB.includes(agentA)) {
    return true;
  }

  return false;
}

/**
 * 获取 Agent 的模型配置
 */
export function getAgentModelConfig(agentId: string, effort?: EffortLevel): {
  model: string;
  maxTurns: number;
  timeout: number;
} {
  const agent = BUILTIN_AGENTS[agentId];
  const effectiveEffort = effort || agent?.defaultEffort || 'medium';
  return EFFORT_CONFIG[effectiveEffort];
}

/**
 * 获取 Agent 可用的工具列表
 */
export function getAgentTools(agentId: string, allTools: string[]): string[] {
  const agent = BUILTIN_AGENTS[agentId];
  if (!agent) {
    return [];
  }

  if (agent.tools === '*') {
    // 排除指定的工具
    if (agent.excludeTools && agent.excludeTools.length > 0) {
      return allTools.filter(tool => !agent.excludeTools!.includes(tool));
    }
    return allTools;
  }

  return agent.tools;
}
