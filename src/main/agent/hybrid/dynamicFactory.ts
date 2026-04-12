// ============================================================================
// Dynamic Agent Factory - 动态 Agent 生成（混合架构 Layer 2）
// ============================================================================
//
// 设计原则：
// 1. 无预设模板：让模型决定需要什么角色
// 2. 按需生成：根据任务复杂度动态创建专用 Agent
// 3. 生命周期管理：任务结束即销毁
//
// 参考：
// - Kimi Agent Swarm 的无模板动态生成
// - LangGraph Send API 的动态 Worker
// - TDAG 论文的后置任务动态调整
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { ModelProvider } from '../../../shared/contract/model';
import {
  type CoreAgentId,
  type ModelTier,
  getModelConfig,
  CORE_AGENTS,
  isCoreAgent,
} from './coreAgents';

const logger = createLogger('DynamicFactory');

// ============================================================================
// Types
// ============================================================================

/**
 * 动态 Agent 规格（模型生成）
 */
export interface DynamicAgentSpec {
  /** 角色名称（如 db-designer, sql-optimizer）*/
  name: string;
  /** 职责描述 */
  responsibility: string;
  /** 需要的工具 */
  tools: string[];
  /** 是否可并行 */
  parallelizable: boolean;
  /** 依赖的其他 Agent（按名称）*/
  dependencies?: string[];
}

/**
 * 动态 Agent 定义（完整配置）
 */
export interface DynamicAgentConfig {
  /** 唯一 ID：dynamic-{name}-{timestamp} */
  id: string;
  /** 显示名称 */
  name: string;
  /** 动态生成的 system prompt */
  prompt: string;
  /** 允许使用的工具 */
  tools: string[];
  /** 模型配置 */
  model: { provider: ModelProvider; model: string };
  /** 最大迭代次数 */
  maxIterations: number;
  /** 超时时间（毫秒）*/
  timeout: number;
  /** 父任务 ID */
  parentTaskId: string;
  /** 是否可并行 */
  parallelizable: boolean;
  /** 依赖的其他 Agent ID */
  dependencies: string[];
  /** 生命周期：任务结束即销毁 */
  ttl: 'task' | 'session';
  /** 原始规格 */
  spec: DynamicAgentSpec;
}

/**
 * 生成上下文
 */
export interface GenerationContext {
  /** 用户任务描述 */
  task: string;
  /** 工作目录 */
  workingDirectory?: string;
  /** 项目结构 */
  projectStructure?: string;
  /** 相关文件 */
  relevantFiles?: string[];
  /** 父任务 ID */
  parentTaskId: string;
}

/**
 * 生成结果
 */
export interface GenerationResult {
  /** 生成的 Agent 列表 */
  agents: DynamicAgentConfig[];
  /** 执行顺序建议 */
  executionOrder: 'parallel' | 'sequential' | 'mixed';
  /** 生成耗时 */
  generationTime: number;
}

// ============================================================================
// Tool Registry
// ============================================================================

/**
 * 可用工具及其描述
 */
const AVAILABLE_TOOLS: Record<string, { description: string; category: string }> = {
  // 文件操作
  'Read': { description: '读取文件内容', category: 'file' },
  'Write': { description: '创建/覆盖文件', category: 'file' },
  'Edit': { description: '编辑文件（替换）', category: 'file' },
  'Glob': { description: '按模式搜索文件', category: 'file' },
  'Grep': { description: '搜索文件内容', category: 'file' },
  'ListDirectory': { description: '列出目录内容', category: 'file' },

  // 执行
  'Bash': { description: '执行 shell 命令', category: 'execution' },

  // 网络
  'WebSearch': { description: '搜索互联网', category: 'network' },
  'WebFetch': { description: '获取网页内容', category: 'network' },

  // 文档
  'ReadDocument': { description: '读取文档文件', category: 'document' },

  // 任务管理
  'AskUserQuestion': { description: '询问用户', category: 'task' },

  // MCP
  'MCPUnified': { description: '调用 MCP 工具', category: 'mcp' },
};

/**
 * 根据需求推荐工具
 */
function recommendTools(responsibility: string, requestedTools?: string[]): string[] {
  const tools = new Set<string>();

  // 基础工具（所有 Agent 都有）
  tools.add('Read');
  tools.add('Glob');

  // 根据职责关键词推荐
  const lower = responsibility.toLowerCase();

  if (lower.includes('write') || lower.includes('create') || lower.includes('implement')) {
    tools.add('Write');
    tools.add('Edit');
  }

  if (lower.includes('search') || lower.includes('find') || lower.includes('explore')) {
    tools.add('Grep');
    tools.add('ListDirectory');
  }

  if (lower.includes('test') || lower.includes('run') || lower.includes('execute') || lower.includes('build')) {
    tools.add('Bash');
  }

  if (lower.includes('web') || lower.includes('internet') || lower.includes('documentation')) {
    tools.add('WebSearch');
    tools.add('WebFetch');
  }

  if (lower.includes('database') || lower.includes('sql') || lower.includes('schema')) {
    tools.add('Bash');
    tools.add('Edit');
  }

  if (lower.includes('pdf') || lower.includes('document')) {
    tools.add('ReadDocument');
  }

  // 添加请求的工具（如果有效）
  if (requestedTools) {
    for (const tool of requestedTools) {
      if (AVAILABLE_TOOLS[tool]) {
        tools.add(tool);
      }
    }
  }

  return Array.from(tools);
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * 生成动态 Agent 的 system prompt
 */
function generateDynamicPrompt(
  spec: DynamicAgentSpec,
  context: GenerationContext
): string {
  const toolDescriptions = spec.tools
    .filter(t => AVAILABLE_TOOLS[t])
    .map(t => `- ${t}: ${AVAILABLE_TOOLS[t].description}`)
    .join('\n');

  return `You are a specialized agent: **${spec.name}**

## Your Responsibility
${spec.responsibility}

## Available Tools
${toolDescriptions}

## Context
- Working Directory: ${context.workingDirectory || 'Not specified'}
${context.projectStructure ? `- Project Structure:\n${context.projectStructure}` : ''}
${context.relevantFiles?.length ? `- Relevant Files: ${context.relevantFiles.join(', ')}` : ''}

## Task
${context.task}

## Guidelines
1. Focus on your specific responsibility
2. Be thorough but efficient
3. Report progress and findings clearly
4. If blocked, explain why and suggest alternatives

## Output Format
Provide structured output:
1. What you did
2. What you found/produced
3. Any issues or blockers
4. Recommendations for next steps (if applicable)`;
}

// ============================================================================
// Analysis Prompt
// ============================================================================

/**
 * 生成任务分析 prompt（让模型决定需要什么 Agent）
 */
export function generateAnalysisPrompt(task: string): string {
  return `Analyze this task and determine what specialized agents are needed:

## Task
${task}

## Instructions
Analyze the task and output a JSON object describing what agents are needed.
Consider:
1. What different types of work are involved?
2. Can some work be done in parallel?
3. What tools will each agent need?

## Output Format
\`\`\`json
{
  "analysis": "Brief analysis of the task",
  "shouldUseDynamicAgents": true/false,
  "reason": "Why dynamic agents are/aren't needed",
  "agents": [
    {
      "name": "agent-name (kebab-case)",
      "responsibility": "What this agent will do",
      "tools": ["tool1", "tool2"],
      "parallelizable": true/false,
      "dependencies": ["other-agent-name"]
    }
  ],
  "executionOrder": "parallel" | "sequential" | "mixed"
}
\`\`\`

## Rules
1. Only suggest dynamic agents for tasks that truly need specialization
2. Simple tasks should use core agents (coder, reviewer, explore, plan)
3. Max 10 agents for any task
4. Name agents descriptively (e.g., "schema-designer", "api-tester")

Available tools: ${Object.keys(AVAILABLE_TOOLS).join(', ')}`;
}

// ============================================================================
// Dynamic Agent Factory
// ============================================================================

/**
 * 动态 Agent 工厂
 *
 * 根据任务需求动态生成专用 Agent。
 * 与预定义的核心角色不同，动态 Agent 是即时生成的，针对特定任务优化。
 */
export class DynamicAgentFactory {
  private activeAgents: Map<string, DynamicAgentConfig> = new Map();

  /**
   * 从模型分析结果创建 Agent
   *
   * @param specs - 模型生成的 Agent 规格列表
   * @param context - 生成上下文
   * @returns 完整的 Agent 配置列表
   */
  createFromSpecs(
    specs: DynamicAgentSpec[],
    context: GenerationContext
  ): GenerationResult {
    const startTime = Date.now();
    const agents: DynamicAgentConfig[] = [];
    const timestamp = Date.now();

    // 构建 name -> id 的映射（用于解析依赖）
    const nameToId = new Map<string, string>();

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const id = `dynamic-${spec.name}-${timestamp}-${i}`;
      nameToId.set(spec.name, id);
    }

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const id = `dynamic-${spec.name}-${timestamp}-${i}`;

      // 解析依赖
      const dependencies = (spec.dependencies || [])
        .map(dep => nameToId.get(dep))
        .filter((id): id is string => id !== undefined);

      // 推荐工具
      const tools = recommendTools(spec.responsibility, spec.tools);

      // 确定模型（根据职责复杂度）
      const modelTier = this.determineModelTier(spec);

      const agent: DynamicAgentConfig = {
        id,
        name: spec.name,
        prompt: generateDynamicPrompt(spec, context),
        tools,
        model: getModelConfig(modelTier),
        maxIterations: this.estimateIterations(spec),
        timeout: this.estimateTimeout(spec),
        parentTaskId: context.parentTaskId,
        parallelizable: spec.parallelizable,
        dependencies,
        ttl: 'task',
        spec,
      };

      agents.push(agent);
      this.activeAgents.set(id, agent);

      logger.debug('Created dynamic agent', {
        id,
        name: spec.name,
        tools: tools.length,
        parallelizable: spec.parallelizable,
      });
    }

    // 确定执行顺序
    const executionOrder = this.determineExecutionOrder(agents);

    logger.info('Dynamic agents created', {
      count: agents.length,
      executionOrder,
      generationTime: Date.now() - startTime,
    });

    return {
      agents,
      executionOrder,
      generationTime: Date.now() - startTime,
    };
  }

  /**
   * 根据核心角色创建简单的动态 Agent
   *
   * 用于将核心角色包装成动态 Agent 格式
   */
  createFromCoreAgent(
    coreAgentId: CoreAgentId,
    context: GenerationContext
  ): DynamicAgentConfig {
    const coreAgent = CORE_AGENTS[coreAgentId];
    const id = `core-${coreAgentId}-${Date.now()}`;

    const agent: DynamicAgentConfig = {
      id,
      name: coreAgent.name,
      prompt: coreAgent.prompt,
      tools: coreAgent.tools,
      model: getModelConfig(coreAgent.model),
      maxIterations: coreAgent.maxIterations,
      timeout: 600000, // 10 minutes
      parentTaskId: context.parentTaskId,
      parallelizable: coreAgent.readonly,
      dependencies: [],
      ttl: 'task',
      spec: {
        name: coreAgentId,
        responsibility: coreAgent.description,
        tools: coreAgent.tools,
        parallelizable: coreAgent.readonly,
      },
    };

    this.activeAgents.set(id, agent);
    return agent;
  }

  /**
   * 获取活跃的 Agent
   */
  getActiveAgent(id: string): DynamicAgentConfig | undefined {
    return this.activeAgents.get(id);
  }

  /**
   * 销毁 Agent（任务结束时调用）
   */
  destroyAgent(id: string): void {
    this.activeAgents.delete(id);
    logger.debug('Destroyed dynamic agent', { id });
  }

  /**
   * 销毁任务相关的所有 Agent
   */
  destroyTaskAgents(parentTaskId: string): void {
    const toDestroy: string[] = [];
    for (const [id, agent] of this.activeAgents) {
      if (agent.parentTaskId === parentTaskId) {
        toDestroy.push(id);
      }
    }
    for (const id of toDestroy) {
      this.activeAgents.delete(id);
    }
    logger.info('Destroyed task agents', { parentTaskId, count: toDestroy.length });
  }

  /**
   * 确定模型层级
   */
  private determineModelTier(spec: DynamicAgentSpec): ModelTier {
    const lower = spec.responsibility.toLowerCase();

    // 复杂任务用 powerful
    if (
      lower.includes('design') ||
      lower.includes('architect') ||
      lower.includes('implement') ||
      lower.includes('refactor')
    ) {
      return 'powerful';
    }

    // 只读搜索用 fast
    if (
      (lower.includes('search') || lower.includes('find') || lower.includes('read')) &&
      !lower.includes('write') &&
      !lower.includes('create')
    ) {
      return 'fast';
    }

    // 其他用 balanced
    return 'balanced';
  }

  /**
   * 估算迭代次数
   */
  private estimateIterations(spec: DynamicAgentSpec): number {
    const lower = spec.responsibility.toLowerCase();

    // 简单搜索任务
    if (lower.includes('search') || lower.includes('find') || lower.includes('list')) {
      return 8;
    }

    // 复杂实现任务
    if (lower.includes('implement') || lower.includes('design') || lower.includes('refactor')) {
      return 15;
    }

    // 测试任务
    if (lower.includes('test') || lower.includes('verify')) {
      return 10;
    }

    return 12;
  }

  /**
   * 估算超时时间
   */
  private estimateTimeout(spec: DynamicAgentSpec): number {
    const iterations = this.estimateIterations(spec);
    // 每次迭代约 30 秒，加上 buffer
    return iterations * 30000 + 60000;
  }

  /**
   * 确定执行顺序
   */
  private determineExecutionOrder(agents: DynamicAgentConfig[]): 'parallel' | 'sequential' | 'mixed' {
    const parallelCount = agents.filter(a => a.parallelizable).length;
    const hasDependent = agents.some(a => a.dependencies.length > 0);

    if (parallelCount === agents.length && !hasDependent) {
      return 'parallel';
    }

    if (parallelCount === 0 || hasDependent) {
      return 'sequential';
    }

    return 'mixed';
  }
}

// ============================================================================
// Singleton
// ============================================================================

let factoryInstance: DynamicAgentFactory | null = null;

export function getDynamicAgentFactory(): DynamicAgentFactory {
  if (!factoryInstance) {
    factoryInstance = new DynamicAgentFactory();
  }
  return factoryInstance;
}
