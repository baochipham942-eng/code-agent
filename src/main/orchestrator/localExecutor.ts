// ============================================================================
// LocalExecutor - 本地执行器
// 封装现有 AgentOrchestrator，提供统一的执行接口
// ============================================================================

import { EventEmitter } from 'events';
import type { Message, ModelConfig, ToolCall, ToolResult } from '../../shared/types';
import type { TaskExecutionLocation } from '../../shared/types/cloud';
import type {
  ExecutorRequest,
  ExecutorResult,
  ExecutionProgressEvent,
  ExecutionContext,
} from './types';
import { getSubagentExecutor } from '../agent/subagentExecutor';

// ============================================================================
// 配置
// ============================================================================

export interface LocalExecutorConfig {
  maxConcurrent: number;
  defaultTimeout: number;
  maxIterations: number;
}

const DEFAULT_CONFIG: LocalExecutorConfig = {
  maxConcurrent: 2,
  defaultTimeout: 120000,
  maxIterations: 30,
};

// ============================================================================
// LocalExecutor 类
// ============================================================================

export class LocalExecutor extends EventEmitter {
  private config: LocalExecutorConfig;
  private runningTasks: Set<string> = new Set();
  private cancelledTasks: Set<string> = new Set();
  private modelConfig?: ModelConfig;

  constructor(config: Partial<LocalExecutorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化
   */
  initialize(modelConfig: ModelConfig): void {
    this.modelConfig = modelConfig;
  }

  /**
   * 执行任务
   */
  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const startTime = Date.now();
    const { requestId, prompt, maxIterations, timeout, context } = request;

    // 检查并发限制
    while (this.runningTasks.size >= this.config.maxConcurrent) {
      await this.sleep(100);
    }

    this.runningTasks.add(requestId);

    // 发送开始事件
    this.emitProgress(requestId, 0, '开始执行');

    try {
      const executor = getSubagentExecutor();

      // 构建 Agent 配置
      const agentConfig = this.buildAgentConfig(request);

      // 发送进度事件
      this.emitProgress(requestId, 10, '初始化 Agent');

      // 执行
      // TODO: SubagentContext 类型定义需要完整的 toolRegistry 和 toolContext
      // 但 SubagentExecutor 内部会自行管理这些，这里使用简化版本
      const result = await executor.execute(
        prompt,
        {
          name: agentConfig.name,
          systemPrompt: agentConfig.systemPrompt,
          availableTools: agentConfig.tools,
          maxIterations: maxIterations || this.config.maxIterations,
        },
        {
          modelConfig: request.modelConfig || this.modelConfig!,
          toolRegistry: new Map(), // SubagentExecutor manages its own tools
          toolContext: {
            workingDirectory: context?.projectPath || process.cwd(),
            generation: { id: 'gen4' },
            requestPermission: async () => true,
          },
        }
      );

      // 发送完成事件
      this.emitProgress(requestId, 100, '执行完成');

      return {
        requestId,
        success: result.success,
        output: result.output,
        error: result.error,
        location: 'local' as TaskExecutionLocation,
        duration: Date.now() - startTime,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        requestId,
        success: false,
        error: errorMessage,
        location: 'local' as TaskExecutionLocation,
        duration: Date.now() - startTime,
        iterations: 0,
        toolsUsed: [],
      };
    } finally {
      this.runningTasks.delete(requestId);
      this.cleanupCancelled(requestId);
    }
  }

  /**
   * 执行简单查询（不使用工具）
   */
  async executeSimple(prompt: string, modelConfig?: ModelConfig): Promise<string> {
    // 简单查询直接调用模型，不需要工具
    const executor = getSubagentExecutor();

    // TODO: SubagentContext 类型需要完整结构，这里使用最小化上下文
    const result = await executor.execute(
      prompt,
      {
        name: 'SimpleQuery',
        systemPrompt: '你是一个智能助手，直接回答用户的问题。',
        availableTools: [],
        maxIterations: 1,
      },
      {
        modelConfig: modelConfig || this.modelConfig!,
        toolRegistry: new Map(),
        toolContext: {
          workingDirectory: process.cwd(),
          generation: { id: 'gen4' },
          requestPermission: async () => true,
        },
      }
    );

    return result.output || '';
  }

  /**
   * 构建 Agent 配置
   */
  private buildAgentConfig(request: ExecutorRequest): {
    name: string;
    systemPrompt: string;
    tools: string[];
  } {
    const taskType = request.taskType || 'analyzer';

    const configs: Record<string, { name: string; systemPrompt: string; tools: string[] }> = {
      researcher: {
        name: 'Researcher',
        systemPrompt: '你是一个研究专家。搜索、分析并总结信息。',
        tools: ['web_fetch', 'grep', 'glob', 'read_file'],
      },
      analyzer: {
        name: 'Analyzer',
        systemPrompt: '你是一个代码分析师。检查代码结构、模式和潜在问题。',
        tools: ['read_file', 'grep', 'glob', 'list_directory'],
      },
      writer: {
        name: 'Writer',
        systemPrompt: '你是一个技术写作者。创建清晰、结构良好的文档和内容。',
        tools: ['read_file', 'write_file', 'edit_file'],
      },
      reviewer: {
        name: 'Reviewer',
        systemPrompt: '你是一个代码审查员。审查代码的 Bug、安全问题和最佳实践。',
        tools: ['read_file', 'grep', 'glob'],
      },
      planner: {
        name: 'Planner',
        systemPrompt: '你是一个任务规划者。分解复杂任务并创建结构化的执行计划。',
        tools: ['todo_write', 'read_file', 'glob'],
      },
    };

    return configs[taskType] || configs.analyzer;
  }

  /**
   * 发送进度事件
   */
  private emitProgress(requestId: string, progress: number, currentStep: string): void {
    const event: ExecutionProgressEvent = {
      requestId,
      progress,
      currentStep,
      location: 'local',
      timestamp: Date.now(),
    };
    this.emit('progress', event);
  }

  /**
   * 获取运行中的任务数
   */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 是否可以接受新任务
   */
  canAcceptTask(): boolean {
    return this.runningTasks.size < this.config.maxConcurrent;
  }

  /**
   * 取消任务
   */
  cancel(requestId: string): boolean {
    if (this.runningTasks.has(requestId)) {
      this.cancelledTasks.add(requestId);
      this.emit('cancelled', { requestId });
      return true;
    }
    return false;
  }

  /**
   * 检查任务是否已取消
   */
  isCancelled(requestId: string): boolean {
    return this.cancelledTasks.has(requestId);
  }

  /**
   * 清理取消状态
   */
  private cleanupCancelled(requestId: string): void {
    this.cancelledTasks.delete(requestId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let executorInstance: LocalExecutor | null = null;

export function getLocalExecutor(): LocalExecutor {
  if (!executorInstance) {
    executorInstance = new LocalExecutor();
  }
  return executorInstance;
}

export function initLocalExecutor(config: Partial<LocalExecutorConfig>): LocalExecutor {
  executorInstance = new LocalExecutor(config);
  return executorInstance;
}
