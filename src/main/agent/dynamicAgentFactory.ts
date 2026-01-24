// ============================================================================
// Dynamic Agent Factory - 根据任务需求动态生成 Agent 定义
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getAgentRegistry, type AgentDefinition } from './types';
import type {
  AgentRequirements,
  AgentTaskType,
  ExecutionStrategy,
} from './agentRequirementsAnalyzer';

const logger = createLogger('DynamicAgentFactory');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 动态 Agent 配置
 *
 * 相比静态 AgentDefinition，DynamicAgentDefinition 是运行时生成的，
 * 针对特定任务优化。
 */
export interface DynamicAgentDefinition {
  /** 唯一标识：auto-{taskType}-{timestamp} */
  id: string;
  /** 显示名称 */
  name: string;
  /** 动态生成的 system prompt */
  systemPrompt: string;
  /** 允许使用的工具列表 */
  tools: string[];
  /** 最大迭代次数 */
  maxIterations: number;
  /** 超时时间（毫秒）*/
  timeout: number;
  /** 父 Agent ID（用于结果汇报）*/
  parentAgentId?: string;
  /** 基础 Agent 定义 ID（如果有）*/
  baseAgentId?: string;
  /** 执行优先级 */
  priority: number;
  /** 是否可以并行执行 */
  canRunParallel: boolean;
  /** 依赖的其他 Agent ID */
  dependencies: string[];
  /** 预算限制（美元）*/
  maxBudget?: number;
  /** 任务类型 */
  taskType: AgentTaskType;
  /** 原始任务描述 */
  taskDescription: string;
}

/**
 * 工厂创建上下文
 */
export interface FactoryContext {
  /** 用户原始消息 */
  userMessage: string;
  /** 项目结构信息 */
  projectStructure?: string;
  /** 相关记忆 */
  relevantMemories?: Array<{
    content: string;
    type: string;
    confidence: number;
  }>;
  /** 工作目录 */
  workingDirectory?: string;
  /** 会话 ID */
  sessionId?: string;
}

// ----------------------------------------------------------------------------
// System Prompt Templates
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATES: Record<AgentTaskType, string> = {
  code: `你是一个专业的代码开发 Agent。

**职责**：
- 编写高质量、可维护的代码
- 遵循项目既有的代码风格和模式
- 确保代码通过类型检查和测试

**工作流程**：
1. 首先理解需求和现有代码结构
2. 设计实现方案
3. 编写代码
4. 验证代码正确性

**注意事项**：
- 优先修改现有文件，避免创建不必要的新文件
- 保持代码简洁，避免过度工程
- 完成后进行类型检查

{contextInfo}

**当前任务**：
{taskDescription}`,

  analysis: `你是一个代码分析 Agent。

**职责**：
- 深入分析代码结构和逻辑
- 识别潜在问题和改进点
- 提供详细的分析报告

**工作流程**：
1. 浏览相关文件和目录
2. 分析代码模式和依赖关系
3. 识别问题和风险
4. 总结发现并提供建议

**输出格式**：
- 发现的问题（按严重程度排序）
- 改进建议
- 风险评估

{contextInfo}

**当前任务**：
{taskDescription}`,

  research: `你是一个研究调查 Agent。

**职责**：
- 深入研究技术问题
- 收集多方面信息
- 整理知识并形成结论

**工作流程**：
1. 明确研究目标
2. 搜索相关信息
3. 分析和对比不同来源
4. 总结发现

**输出格式**：
- 研究发现摘要
- 详细分析
- 结论和建议
- 参考来源

{contextInfo}

**当前任务**：
{taskDescription}`,

  documentation: `你是一个文档编写 Agent。

**职责**：
- 编写清晰、准确的文档
- 确保文档与代码一致
- 遵循项目文档风格

**工作流程**：
1. 理解需要文档化的内容
2. 阅读相关代码
3. 编写文档
4. 验证准确性

**注意事项**：
- 使用简洁清晰的语言
- 包含必要的代码示例
- 保持格式一致

{contextInfo}

**当前任务**：
{taskDescription}`,

  testing: `你是一个测试开发 Agent。

**职责**：
- 编写全面的测试用例
- 确保测试覆盖关键路径
- 验证代码行为正确

**工作流程**：
1. 分析需要测试的代码
2. 设计测试用例
3. 编写测试代码
4. 运行并验证测试

**测试类型**：
- 单元测试
- 集成测试
- 边界条件测试

{contextInfo}

**当前任务**：
{taskDescription}`,

  devops: `你是一个 DevOps Agent。

**职责**：
- 处理构建和部署任务
- 管理 CI/CD 配置
- 优化开发工作流

**工作流程**：
1. 理解当前配置
2. 执行必要的命令
3. 验证结果
4. 处理问题

**注意事项**：
- 谨慎执行破坏性命令
- 保留备份和回滚方案
- 记录所有更改

{contextInfo}

**当前任务**：
{taskDescription}`,

  mixed: `你是一个全能型 Agent，可以处理多种类型的任务。

**职责**：
- 协调多种类型的工作
- 根据任务需求选择合适的方法
- 确保任务整体完成

**工作流程**：
1. 分析任务组成部分
2. 规划执行顺序
3. 逐步完成各部分
4. 整合结果

{contextInfo}

**当前任务**：
{taskDescription}`,
};

// ----------------------------------------------------------------------------
// Tool Mappings
// ----------------------------------------------------------------------------

const TASK_TYPE_TOOLS: Record<AgentTaskType, string[]> = {
  code: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'todo_write'],
  analysis: ['read_file', 'glob', 'grep', 'list_directory'],
  research: ['web_fetch', 'web_search', 'read_file', 'glob'],
  documentation: ['read_file', 'write_file', 'glob', 'grep'],
  testing: ['bash', 'read_file', 'write_file', 'glob', 'grep'],
  devops: ['bash', 'read_file', 'write_file', 'glob'],
  mixed: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'todo_write'],
};

const ITERATION_LIMITS: Record<AgentTaskType, number> = {
  code: 15,
  analysis: 20,
  research: 25,
  documentation: 10,
  testing: 15,
  devops: 10,
  mixed: 20,
};

const TIMEOUT_LIMITS: Record<AgentTaskType, number> = {
  code: 600000,       // 10 minutes
  analysis: 300000,   // 5 minutes
  research: 900000,   // 15 minutes
  documentation: 300000, // 5 minutes
  testing: 600000,    // 10 minutes
  devops: 600000,     // 10 minutes
  mixed: 900000,      // 15 minutes
};

// ----------------------------------------------------------------------------
// Dynamic Agent Factory
// ----------------------------------------------------------------------------

/**
 * 动态 Agent 工厂
 *
 * 根据任务需求动态创建 Agent 定义，无需用户配置。
 */
export class DynamicAgentFactory {
  private registry = getAgentRegistry();

  /**
   * 根据需求创建 Agent 定义
   */
  create(
    requirements: AgentRequirements,
    context: FactoryContext
  ): DynamicAgentDefinition[] {
    const agents: DynamicAgentDefinition[] = [];
    const timestamp = Date.now();

    logger.info('Creating dynamic agents', {
      taskType: requirements.taskType,
      strategy: requirements.executionStrategy,
      needsAutoAgent: requirements.needsAutoAgent,
    });

    // 如果不需要自动 Agent，返回空
    if (!requirements.needsAutoAgent) {
      logger.debug('Auto agent not needed, returning empty');
      return agents;
    }

    // 创建主 Agent
    const primaryAgent = this.createPrimaryAgent(
      requirements,
      context,
      timestamp
    );
    agents.push(primaryAgent);

    // 根据执行策略创建辅助 Agent
    if (requirements.executionStrategy === 'parallel') {
      const supportingAgents = this.createSupportingAgents(
        requirements,
        context,
        timestamp,
        primaryAgent.id
      );
      agents.push(...supportingAgents);
    }

    logger.info(`Created ${agents.length} dynamic agents`, {
      agents: agents.map(a => ({ id: a.id, taskType: a.taskType })),
    });

    return agents;
  }

  /**
   * 创建主 Agent
   */
  private createPrimaryAgent(
    requirements: AgentRequirements,
    context: FactoryContext,
    timestamp: number
  ): DynamicAgentDefinition {
    const { taskType, suggestedAgents, toolConstraints } = requirements;

    // 尝试获取基础 Agent 定义
    const baseAgent = this.registry.get(suggestedAgents.primary);

    // 构建上下文信息
    const contextInfo = this.buildContextInfo(context);

    // 生成 system prompt
    const systemPrompt = this.generateSystemPrompt(
      taskType,
      context.userMessage,
      contextInfo
    );

    // 合并工具列表
    const tools = this.mergeTools(
      toolConstraints.required,
      toolConstraints.optional,
      toolConstraints.forbidden,
      baseAgent?.availableTools
    );

    return {
      id: `auto-${taskType}-${timestamp}`,
      name: this.getAgentName(taskType, 'primary'),
      systemPrompt,
      tools,
      maxIterations: requirements.estimatedIterations || ITERATION_LIMITS[taskType],
      timeout: TIMEOUT_LIMITS[taskType],
      parentAgentId: undefined,
      baseAgentId: baseAgent?.id,
      priority: 1,
      canRunParallel: false,
      dependencies: [],
      maxBudget: 0.1, // $0.10 default budget per agent
      taskType,
      taskDescription: context.userMessage,
    };
  }

  /**
   * 创建辅助 Agent
   */
  private createSupportingAgents(
    requirements: AgentRequirements,
    context: FactoryContext,
    timestamp: number,
    parentAgentId: string
  ): DynamicAgentDefinition[] {
    const agents: DynamicAgentDefinition[] = [];
    const { suggestedAgents, taskType } = requirements;

    for (let i = 0; i < suggestedAgents.supporting.length; i++) {
      const supportingType = suggestedAgents.supporting[i];
      const baseAgent = this.registry.get(supportingType);

      if (!baseAgent) {
        logger.warn(`Supporting agent type not found: ${supportingType}`);
        continue;
      }

      // 为辅助 Agent 生成专门的 prompt
      const supportingPrompt = this.generateSupportingPrompt(
        supportingType,
        context.userMessage,
        this.buildContextInfo(context)
      );

      agents.push({
        id: `auto-${supportingType}-${timestamp}-${i}`,
        name: this.getAgentName(supportingType as AgentTaskType, 'supporting'),
        systemPrompt: supportingPrompt,
        tools: baseAgent.availableTools,
        maxIterations: Math.floor(baseAgent.maxIterations * 0.7),
        timeout: Math.floor(baseAgent.timeout * 0.7),
        parentAgentId,
        baseAgentId: baseAgent.id,
        priority: 2 + i,
        canRunParallel: true,
        dependencies: [],
        maxBudget: 0.05, // $0.05 for supporting agents
        taskType,
        taskDescription: `Support task: ${context.userMessage}`,
      });
    }

    return agents;
  }

  /**
   * 生成 System Prompt
   */
  private generateSystemPrompt(
    taskType: AgentTaskType,
    taskDescription: string,
    contextInfo: string
  ): string {
    const template = SYSTEM_PROMPT_TEMPLATES[taskType];
    return template
      .replace('{contextInfo}', contextInfo)
      .replace('{taskDescription}', taskDescription);
  }

  /**
   * 生成辅助 Agent 的 Prompt
   */
  private generateSupportingPrompt(
    agentType: string,
    taskDescription: string,
    contextInfo: string
  ): string {
    const baseAgent = this.registry.get(agentType);
    const description = baseAgent?.description || agentType;

    return `你是一个辅助 Agent：${description}

**角色**：${agentType}

**任务**：作为辅助角色，支持主任务的完成。

${contextInfo}

**主任务描述**：
${taskDescription}

**注意**：专注于你的专长领域，提供高质量的辅助工作。`;
  }

  /**
   * 构建上下文信息
   */
  private buildContextInfo(context: FactoryContext): string {
    const parts: string[] = [];

    if (context.workingDirectory) {
      parts.push(`**工作目录**：${context.workingDirectory}`);
    }

    if (context.projectStructure) {
      parts.push(`**项目结构**：\n${context.projectStructure}`);
    }

    if (context.relevantMemories && context.relevantMemories.length > 0) {
      const memoryText = context.relevantMemories
        .filter(m => m.confidence > 0.7)
        .map(m => `- [${m.type}] ${m.content}`)
        .join('\n');
      if (memoryText) {
        parts.push(`**相关经验**：\n${memoryText}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 合并工具列表
   */
  private mergeTools(
    required: string[],
    optional: string[],
    forbidden: string[],
    baseTools?: string[]
  ): string[] {
    const tools = new Set<string>();

    // 添加必需工具
    for (const tool of required) {
      tools.add(tool);
    }

    // 添加基础工具
    if (baseTools) {
      for (const tool of baseTools) {
        if (!forbidden.includes(tool)) {
          tools.add(tool);
        }
      }
    }

    // 添加可选工具
    for (const tool of optional) {
      if (!forbidden.includes(tool)) {
        tools.add(tool);
      }
    }

    // 移除禁用工具
    for (const tool of forbidden) {
      tools.delete(tool);
    }

    return Array.from(tools);
  }

  /**
   * 获取 Agent 名称
   */
  private getAgentName(taskType: AgentTaskType, role: 'primary' | 'supporting'): string {
    const typeNames: Record<AgentTaskType, string> = {
      code: '代码开发',
      analysis: '代码分析',
      research: '研究调查',
      documentation: '文档编写',
      testing: '测试开发',
      devops: '运维部署',
      mixed: '综合处理',
    };

    const prefix = role === 'primary' ? '主' : '辅助';
    return `${prefix} Agent (${typeNames[taskType]})`;
  }

  /**
   * 估算 Agent 执行所需资源
   */
  estimateResources(agents: DynamicAgentDefinition[]): {
    totalIterations: number;
    totalTimeout: number;
    estimatedCost: number;
    parallelizable: number;
  } {
    let totalIterations = 0;
    let totalTimeout = 0;
    let estimatedCost = 0;
    let parallelizable = 0;

    for (const agent of agents) {
      totalIterations += agent.maxIterations;
      estimatedCost += agent.maxBudget || 0;

      if (agent.canRunParallel) {
        parallelizable++;
        // 并行 agent 不累加超时
        totalTimeout = Math.max(totalTimeout, agent.timeout);
      } else {
        totalTimeout += agent.timeout;
      }
    }

    return {
      totalIterations,
      totalTimeout,
      estimatedCost,
      parallelizable,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let factoryInstance: DynamicAgentFactory | null = null;

/**
 * 获取 DynamicAgentFactory 单例
 */
export function getDynamicAgentFactory(): DynamicAgentFactory {
  if (!factoryInstance) {
    factoryInstance = new DynamicAgentFactory();
  }
  return factoryInstance;
}
