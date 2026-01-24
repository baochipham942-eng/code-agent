// ============================================================================
// Agent Requirements Analyzer - 分析任务需求并推荐 Agent 配置
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getAutoDelegator, type TaskAnalysis } from './autoDelegator';

const logger = createLogger('AgentRequirementsAnalyzer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 任务类型
 */
export type AgentTaskType =
  | 'code'           // 写代码
  | 'analysis'       // 代码分析/审查
  | 'research'       // 研究/调查
  | 'documentation'  // 写文档
  | 'testing'        // 测试
  | 'devops'         // 部署/构建/CI
  | 'mixed';         // 混合任务

/**
 * 执行策略
 */
export type ExecutionStrategy = 'direct' | 'sequential' | 'parallel';

/**
 * 推荐的 Agent 类型
 */
export interface SuggestedAgents {
  /** 主 Agent */
  primary: string;
  /** 辅助 Agent（可并行） */
  supporting: string[];
}

/**
 * 工具约束
 */
export interface ToolConstraints {
  /** 必须的工具 */
  required: string[];
  /** 可选工具 */
  optional: string[];
  /** 禁用工具（安全考虑） */
  forbidden: string[];
}

/**
 * Agent 需求分析结果
 */
export interface AgentRequirements {
  /** 任务类型 */
  taskType: AgentTaskType;
  /** 推荐的 Agent */
  suggestedAgents: SuggestedAgents;
  /** 工具约束 */
  toolConstraints: ToolConstraints;
  /** 执行策略 */
  executionStrategy: ExecutionStrategy;
  /** 预估迭代次数 */
  estimatedIterations: number;
  /** 分析置信度 (0-1) */
  confidence: number;
  /** 是否需要自动生成 Agent */
  needsAutoAgent: boolean;
  /** 原始任务分析 */
  rawAnalysis: TaskAnalysis;
}

// ----------------------------------------------------------------------------
// Task Type Detection
// ----------------------------------------------------------------------------

/**
 * 任务类型信号词
 */
const TASK_TYPE_SIGNALS: Record<AgentTaskType, RegExp[]> = {
  code: [
    /\b(write|create|implement|add|make|build|develop)\b/i,
    /\b(feature|function|component|module|class|method)\b/i,
    /\b(写|创建|实现|开发|添加|新增)\b/,
    /\b(功能|组件|模块|类|方法)\b/,
  ],
  analysis: [
    /\b(analyze|review|audit|check|examine|inspect)\b/i,
    /\b(分析|审查|检查|审计|查看)\b/,
    /\b(bug|issue|problem|error|vulnerability)\b/i,
    /\b(问题|漏洞|错误)\b/,
  ],
  research: [
    /\b(research|investigate|explore|find out|study|learn)\b/i,
    /\b(研究|调查|探索|了解|学习)\b/,
    /\b(how does|what is|why|explain)\b/i,
    /\b(怎么|什么是|为什么|解释)\b/,
  ],
  documentation: [
    /\b(document|readme|explain|describe|write docs)\b/i,
    /\b(文档|说明|描述|README)\b/,
    /\b(comment|jsdoc|annotation)\b/i,
    /\b(注释|文档注释)\b/,
  ],
  testing: [
    /\b(test|spec|coverage|unit test|integration test|e2e)\b/i,
    /\b(测试|覆盖率|单元测试|集成测试)\b/,
    /\b(mock|stub|fixture)\b/i,
  ],
  devops: [
    /\b(deploy|build|ci|cd|docker|kubernetes|k8s)\b/i,
    /\b(部署|构建|容器|镜像)\b/,
    /\b(pipeline|workflow|action)\b/i,
    /\b(流水线|工作流)\b/,
  ],
  mixed: [],
};

/**
 * Agent 类型推荐映射
 */
const AGENT_RECOMMENDATIONS: Record<AgentTaskType, SuggestedAgents> = {
  code: {
    primary: 'orchestrator',
    supporting: ['code-review', 'bash'],
  },
  analysis: {
    primary: 'code-review',
    supporting: ['explore'],
  },
  research: {
    primary: 'researcher',
    supporting: ['explore'],
  },
  documentation: {
    primary: 'orchestrator',
    supporting: ['explore'],
  },
  testing: {
    primary: 'bash',
    supporting: ['explore', 'code-review'],
  },
  devops: {
    primary: 'bash',
    supporting: ['explore'],
  },
  mixed: {
    primary: 'orchestrator',
    supporting: ['explore', 'bash', 'code-review'],
  },
};

/**
 * 工具推荐映射
 */
const TOOL_RECOMMENDATIONS: Record<AgentTaskType, ToolConstraints> = {
  code: {
    required: ['read_file', 'write_file', 'edit_file', 'glob'],
    optional: ['bash', 'grep', 'todo_write'],
    forbidden: [],
  },
  analysis: {
    required: ['read_file', 'glob', 'grep'],
    optional: ['bash'],
    forbidden: ['write_file', 'edit_file'],
  },
  research: {
    required: ['web_fetch', 'web_search'],
    optional: ['read_file', 'glob'],
    forbidden: [],
  },
  documentation: {
    required: ['read_file', 'write_file', 'glob'],
    optional: ['grep'],
    forbidden: [],
  },
  testing: {
    required: ['bash', 'read_file', 'glob'],
    optional: ['write_file'],
    forbidden: [],
  },
  devops: {
    required: ['bash', 'read_file'],
    optional: ['write_file', 'glob'],
    forbidden: [],
  },
  mixed: {
    required: ['read_file', 'glob', 'grep'],
    optional: ['write_file', 'edit_file', 'bash', 'web_fetch'],
    forbidden: [],
  },
};

// ----------------------------------------------------------------------------
// Agent Requirements Analyzer
// ----------------------------------------------------------------------------

/**
 * Agent 需求分析器
 *
 * 分析用户任务，确定是否需要自动生成 Agent，
 * 推荐合适的 Agent 配置和执行策略。
 */
export class AgentRequirementsAnalyzer {
  private autoDelegator = getAutoDelegator();

  /**
   * 分析任务需求
   *
   * @param userMessage - 用户消息
   * @param workingDirectory - 工作目录
   * @returns Agent 需求分析结果
   */
  async analyze(
    userMessage: string,
    workingDirectory?: string
  ): Promise<AgentRequirements> {
    logger.debug('Analyzing task requirements', { messageLength: userMessage.length });

    // 获取基础任务分析
    const rawAnalysis = this.autoDelegator.analyzeTask(userMessage);

    // 检测任务类型
    const taskType = this.detectTaskType(userMessage, rawAnalysis);

    // 获取推荐的 Agent
    const suggestedAgents = this.getSuggestedAgents(taskType, rawAnalysis);

    // 获取工具约束
    const toolConstraints = this.getToolConstraints(taskType, rawAnalysis);

    // 确定执行策略
    const executionStrategy = this.determineExecutionStrategy(
      taskType,
      rawAnalysis,
      suggestedAgents
    );

    // 估算迭代次数
    const estimatedIterations = this.estimateIterations(
      taskType,
      rawAnalysis,
      executionStrategy
    );

    // 计算置信度
    const confidence = this.calculateConfidence(rawAnalysis, taskType);

    // 判断是否需要自动生成 Agent
    const needsAutoAgent = this.shouldGenerateAutoAgent(
      rawAnalysis,
      taskType,
      executionStrategy,
      confidence
    );

    const requirements: AgentRequirements = {
      taskType,
      suggestedAgents,
      toolConstraints,
      executionStrategy,
      estimatedIterations,
      confidence,
      needsAutoAgent,
      rawAnalysis,
    };

    logger.info('Requirements analysis complete', {
      taskType,
      executionStrategy,
      needsAutoAgent,
      confidence: confidence.toFixed(2),
    });

    return requirements;
  }

  /**
   * 检测任务类型
   */
  private detectTaskType(
    message: string,
    analysis: TaskAnalysis
  ): AgentTaskType {
    const typeScores: Record<AgentTaskType, number> = {
      code: 0,
      analysis: 0,
      research: 0,
      documentation: 0,
      testing: 0,
      devops: 0,
      mixed: 0,
    };

    // 基于信号词计算得分
    for (const [type, patterns] of Object.entries(TASK_TYPE_SIGNALS)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          typeScores[type as AgentTaskType] += 1;
        }
      }
    }

    // 基于基础分析调整得分
    if (analysis.involvesFiles && analysis.taskType === 'write') {
      typeScores.code += 2;
    }
    if (analysis.taskType === 'review') {
      typeScores.analysis += 2;
    }
    if (analysis.involvesNetwork) {
      typeScores.research += 1;
    }
    if (analysis.involvesExecution) {
      typeScores.testing += 1;
      typeScores.devops += 1;
    }

    // 找出最高得分
    let maxType: AgentTaskType = 'code';
    let maxScore = 0;
    let secondMaxScore = 0;

    for (const [type, score] of Object.entries(typeScores)) {
      if (score > maxScore) {
        secondMaxScore = maxScore;
        maxScore = score;
        maxType = type as AgentTaskType;
      } else if (score > secondMaxScore) {
        secondMaxScore = score;
      }
    }

    // 如果多个类型得分接近，标记为 mixed
    if (maxScore > 0 && secondMaxScore > 0 && maxScore - secondMaxScore <= 1) {
      return 'mixed';
    }

    // 如果没有明确类型，根据复杂度判断
    if (maxScore === 0) {
      return analysis.complexity === 'complex' ? 'mixed' : 'code';
    }

    return maxType;
  }

  /**
   * 获取推荐的 Agent
   */
  private getSuggestedAgents(
    taskType: AgentTaskType,
    analysis: TaskAnalysis
  ): SuggestedAgents {
    const base = AGENT_RECOMMENDATIONS[taskType];

    // 根据具体分析结果调整
    const supporting = [...base.supporting];

    // 如果涉及网络，添加 researcher
    if (analysis.involvesNetwork && !supporting.includes('researcher')) {
      supporting.push('researcher');
    }

    // 如果涉及执行，确保有 bash
    if (analysis.involvesExecution && !supporting.includes('bash')) {
      supporting.push('bash');
    }

    return {
      primary: base.primary,
      supporting,
    };
  }

  /**
   * 获取工具约束
   */
  private getToolConstraints(
    taskType: AgentTaskType,
    analysis: TaskAnalysis
  ): ToolConstraints {
    const base = TOOL_RECOMMENDATIONS[taskType];

    const required = [...base.required];
    const optional = [...base.optional];
    const forbidden = [...base.forbidden];

    // 根据分析结果调整
    if (analysis.involvesNetwork) {
      if (!required.includes('web_fetch')) {
        optional.push('web_fetch', 'web_search');
      }
    }

    // 如果是只读分析任务，禁止写操作
    if (taskType === 'analysis' && !analysis.involvesFiles) {
      if (!forbidden.includes('write_file')) {
        forbidden.push('write_file', 'edit_file');
      }
    }

    return { required, optional, forbidden };
  }

  /**
   * 确定执行策略
   */
  private determineExecutionStrategy(
    taskType: AgentTaskType,
    analysis: TaskAnalysis,
    suggestedAgents: SuggestedAgents
  ): ExecutionStrategy {
    // 简单任务直接执行
    if (analysis.complexity === 'simple') {
      return 'direct';
    }

    // 研究和分析任务通常是顺序的
    if (taskType === 'research' || taskType === 'analysis') {
      return 'sequential';
    }

    // 有多个辅助 Agent 且任务复杂，考虑并行
    if (
      analysis.complexity === 'complex' &&
      suggestedAgents.supporting.length >= 2
    ) {
      return 'parallel';
    }

    // 混合任务默认顺序执行
    if (taskType === 'mixed') {
      return 'sequential';
    }

    // 默认顺序执行
    return 'sequential';
  }

  /**
   * 估算迭代次数
   */
  private estimateIterations(
    taskType: AgentTaskType,
    analysis: TaskAnalysis,
    strategy: ExecutionStrategy
  ): number {
    // 基础迭代数
    let base = 5;

    // 根据复杂度调整
    switch (analysis.complexity) {
      case 'simple':
        base = 3;
        break;
      case 'moderate':
        base = 8;
        break;
      case 'complex':
        base = 15;
        break;
    }

    // 根据任务类型调整
    switch (taskType) {
      case 'research':
        base = Math.max(base, 10);
        break;
      case 'code':
        base = Math.max(base, 8);
        break;
      case 'testing':
        base = Math.max(base, 6);
        break;
    }

    // 并行策略可能需要更少总迭代
    if (strategy === 'parallel') {
      base = Math.ceil(base * 0.7);
    }

    return base;
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(
    analysis: TaskAnalysis,
    taskType: AgentTaskType
  ): number {
    let confidence = 0.5;

    // 有明确任务类型加分
    if (analysis.taskType !== 'unknown') {
      confidence += 0.2;
    }

    // 有关键词匹配加分
    if (analysis.keywords.length > 0) {
      confidence += Math.min(0.1 * analysis.keywords.length, 0.2);
    }

    // 有明确能力需求加分
    if (analysis.requiredCapabilities.length > 0) {
      confidence += 0.1;
    }

    // 复杂度不明确减分
    if (analysis.complexity === 'simple' && analysis.taskType === 'unknown') {
      confidence -= 0.1;
    }

    return Math.max(0.1, Math.min(1, confidence));
  }

  /**
   * 判断是否需要自动生成 Agent
   */
  private shouldGenerateAutoAgent(
    analysis: TaskAnalysis,
    taskType: AgentTaskType,
    strategy: ExecutionStrategy,
    confidence: number
  ): boolean {
    // 直接执行策略不需要自动生成
    if (strategy === 'direct') {
      return false;
    }

    // 置信度太低不自动生成
    if (confidence < 0.4) {
      return false;
    }

    // 简单任务不需要
    if (analysis.complexity === 'simple') {
      return false;
    }

    // 复杂任务或并行策略需要自动生成
    if (analysis.complexity === 'complex' || strategy === 'parallel') {
      return true;
    }

    // 混合类型任务需要
    if (taskType === 'mixed') {
      return true;
    }

    return false;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let analyzerInstance: AgentRequirementsAnalyzer | null = null;

/**
 * 获取 AgentRequirementsAnalyzer 单例
 */
export function getAgentRequirementsAnalyzer(): AgentRequirementsAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new AgentRequirementsAnalyzer();
  }
  return analyzerInstance;
}
