// ============================================================================
// Cowork Orchestrator - 多 Agent 协调器
// Phase 1: Cowork 角色体系重构
// ============================================================================

import type { ModelConfig } from '../../shared/types';
import type {
  CoworkContract,
  CoworkTaskInput,
  CoworkResult,
  CoworkAgentResult,
} from '../../shared/types/cowork';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import {
  resolveContract,
  mergeContractOverrides,
  validateContract,
  calculateExecutionOrder,
  type ExecutionStage,
} from './coworkContract';
import { getSubagentExecutor } from '../agent/subagentExecutor';
import {
  getPredefinedAgent,
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from '../agent/agentDefinition';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../agent/subagentContextBuilder';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CoworkOrchestrator');

// ============================================================================
// Types
// ============================================================================

export interface CoworkOrchestratorConfig {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  /** 最大并行数（默认 4） */
  maxParallelism?: number;
  /** 是否启用上下文注入（默认 true） */
  enableContextInjection?: boolean;
}

// ============================================================================
// Cowork Orchestrator
// ============================================================================

/**
 * Cowork 协调器
 *
 * 负责执行 Cowork 合约，协调多个 Agent 完成任务
 */
export class CoworkOrchestrator {
  private config: CoworkOrchestratorConfig;

  constructor(config: CoworkOrchestratorConfig) {
    this.config = {
      maxParallelism: 4,
      enableContextInjection: true,
      ...config,
    };
  }

  /**
   * 执行 Cowork 任务
   */
  async execute(input: CoworkTaskInput): Promise<CoworkResult> {
    const startTime = Date.now();

    // 1. 解析合约
    const baseContract = resolveContract(input.contract);
    if (!baseContract) {
      return this.createErrorResult(
        typeof input.contract === 'string' ? input.contract : 'custom',
        `Unknown contract: ${input.contract}`,
        startTime
      );
    }

    // 2. 应用覆盖配置
    const contract = mergeContractOverrides(baseContract, input.overrides);

    // 3. 验证合约
    const validation = validateContract(contract);
    if (!validation.valid) {
      return this.createErrorResult(
        contract.id,
        `Contract validation failed: ${validation.errors.join(', ')}`,
        startTime
      );
    }

    // 记录警告
    for (const warning of validation.warnings) {
      logger.warn(`Contract warning: ${warning}`);
    }

    // 4. 计算执行顺序
    const stages = calculateExecutionOrder(contract);
    logger.info('Calculated execution stages', {
      contractId: contract.id,
      stages: stages.map(s => ({ stage: s.stage, agents: s.agents })),
    });

    // 5. 按阶段执行
    const agentResults: CoworkAgentResult[] = [];
    const errors: Array<{ agentType: string; error: string }> = [];
    let maxParallelism = 0;

    for (const stage of stages) {
      const stageResults = await this.executeStage(
        stage,
        contract,
        input.taskDescription,
        input.context,
        agentResults
      );

      maxParallelism = Math.max(maxParallelism, stage.agents.length);
      agentResults.push(...stageResults);

      // 收集错误
      for (const result of stageResults) {
        if (!result.success && result.error) {
          errors.push({ agentType: result.agentType, error: result.error });
        }
      }

      // 检查是否需要中止（fail-fast 策略）
      if (contract.executionRules.failureStrategy === 'fail-fast') {
        const hasFailure = stageResults.some(r => !r.success);
        if (hasFailure) {
          logger.warn('Fail-fast triggered, aborting execution', {
            stage: stage.stage,
            failedAgents: stageResults.filter(r => !r.success).map(r => r.agentType),
          });
          break;
        }
      }
    }

    // 6. 聚合结果
    const aggregatedOutput = this.aggregateResults(contract, agentResults);
    const success = errors.length === 0 ||
      contract.executionRules.failureStrategy === 'continue';

    return {
      contractId: contract.id,
      success,
      agentResults,
      aggregatedOutput,
      totalDuration: Date.now() - startTime,
      maxParallelism,
      errors,
    };
  }

  /**
   * 执行单个阶段（并行执行该阶段的所有 Agent）
   */
  private async executeStage(
    stage: ExecutionStage,
    contract: CoworkContract,
    taskDescription: string,
    context: CoworkTaskInput['context'],
    previousResults: CoworkAgentResult[]
  ): Promise<CoworkAgentResult[]> {
    const { maxParallelism } = this.config;

    // 限制并行数
    const batches: string[][] = [];
    for (let i = 0; i < stage.agents.length; i += maxParallelism!) {
      batches.push(stage.agents.slice(i, i + maxParallelism!));
    }

    const results: CoworkAgentResult[] = [];

    for (const batch of batches) {
      const batchPromises = batch.map(agentType =>
        this.executeAgent(agentType, contract, taskDescription, context, previousResults)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * 执行单个 Agent
   */
  private async executeAgent(
    agentType: string,
    contract: CoworkContract,
    taskDescription: string,
    context: CoworkTaskInput['context'],
    previousResults: CoworkAgentResult[]
  ): Promise<CoworkAgentResult> {
    const startTime = Date.now();

    // 获取 Agent 配置
    const agentConfig = getPredefinedAgent(agentType);
    if (!agentConfig) {
      return {
        agentType,
        success: false,
        output: '',
        error: `Unknown agent type: ${agentType}`,
        duration: Date.now() - startTime,
        toolsUsed: [],
      };
    }

    // 获取角色定义
    const role = contract.agentRoles.find(r => r.agentType === agentType);

    // 构建增强的任务提示
    const enhancedPrompt = this.buildEnhancedPrompt(
      taskDescription,
      role,
      context,
      previousResults
    );

    // 构建系统提示（包含上下文注入）
    let systemPrompt = getAgentPrompt(agentConfig);

    if (this.config.enableContextInjection && this.config.toolContext.messages) {
      try {
        const contextLevel = getAgentContextLevel(agentType);
        const contextBuilder = new SubagentContextBuilder({
          sessionId: this.config.toolContext.sessionId || 'cowork',
          messages: this.config.toolContext.messages,
          contextLevel,
          todos: this.config.toolContext.todos,
          modifiedFiles: this.config.toolContext.modifiedFiles,
        });

        const subagentContext = await contextBuilder.build(enhancedPrompt);
        const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);

        if (contextPrompt) {
          systemPrompt = systemPrompt + contextPrompt;
        }
      } catch (err) {
        logger.warn('Failed to inject context for agent', { agentType, error: err });
      }
    }

    // 执行 Agent
    try {
      const executor = getSubagentExecutor();
      const result = await executor.execute(
        enhancedPrompt,
        {
          name: agentConfig.name,
          systemPrompt,
          availableTools: getAgentTools(agentConfig),
          maxIterations: getAgentMaxIterations(agentConfig),
          permissionPreset: getAgentPermissionPreset(agentConfig),
          maxBudget: getAgentMaxBudget(agentConfig),
        },
        {
          modelConfig: this.config.modelConfig,
          toolRegistry: this.config.toolRegistry,
          toolContext: this.config.toolContext,
        }
      );

      return {
        agentType,
        success: result.success,
        output: result.output,
        error: result.error,
        duration: Date.now() - startTime,
        toolsUsed: result.toolsUsed,
      };
    } catch (error) {
      return {
        agentType,
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
        toolsUsed: [],
      };
    }
  }

  /**
   * 构建增强的任务提示
   */
  private buildEnhancedPrompt(
    taskDescription: string,
    role: { responsibilities: string[]; deliverables: string[] } | undefined,
    context: CoworkTaskInput['context'],
    previousResults: CoworkAgentResult[]
  ): string {
    const parts: string[] = [];

    // 1. 主任务描述
    parts.push(`## 任务\n${taskDescription}`);

    // 2. 角色职责（如果有）
    if (role) {
      parts.push(`\n## 你的职责\n${role.responsibilities.map(r => `- ${r}`).join('\n')}`);
      parts.push(`\n## 预期交付\n${role.deliverables.map(d => `- ${d}`).join('\n')}`);
    }

    // 3. 上下文文件（如果有）
    if (context?.files && context.files.length > 0) {
      parts.push(`\n## 相关文件\n${context.files.map(f => `- ${f}`).join('\n')}`);
    }

    // 4. 额外上下文（如果有）
    if (context?.additionalContext) {
      parts.push(`\n## 额外上下文\n${context.additionalContext}`);
    }

    // 5. 前置 Agent 的结果（如果有）
    if (previousResults.length > 0) {
      const successfulResults = previousResults.filter(r => r.success);
      if (successfulResults.length > 0) {
        const summaries = successfulResults.map(r => {
          const output = r.output.length > 500 ? r.output.substring(0, 500) + '...' : r.output;
          return `### ${r.agentType}\n${output}`;
        });
        parts.push(`\n## 前置工作结果\n${summaries.join('\n\n')}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 聚合结果
   */
  private aggregateResults(
    contract: CoworkContract,
    results: CoworkAgentResult[]
  ): string {
    const parts: string[] = [];

    parts.push(`# ${contract.name} 执行结果\n`);

    // 统计
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    parts.push(`**完成情况**: ${successCount}/${totalCount} 个 Agent 成功\n`);

    // 各 Agent 结果
    for (const result of results) {
      const status = result.success ? '✅' : '❌';
      parts.push(`## ${status} ${result.agentType}\n`);
      parts.push(`- 耗时: ${result.duration}ms`);
      parts.push(`- 工具: ${result.toolsUsed.join(', ') || '无'}\n`);

      if (result.success) {
        parts.push(`### 输出\n${result.output}\n`);
      } else {
        parts.push(`### 错误\n${result.error || '未知错误'}\n`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 创建错误结果
   */
  private createErrorResult(
    contractId: string,
    error: string,
    startTime: number
  ): CoworkResult {
    return {
      contractId,
      success: false,
      agentResults: [],
      aggregatedOutput: `Error: ${error}`,
      totalDuration: Date.now() - startTime,
      maxParallelism: 0,
      errors: [{ agentType: 'orchestrator', error }],
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * 创建 Cowork 协调器
 */
export function createCoworkOrchestrator(
  config: CoworkOrchestratorConfig
): CoworkOrchestrator {
  return new CoworkOrchestrator(config);
}
