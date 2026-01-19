// ============================================================================
// AgentExecutor - Agent 执行器
// 执行单个 Agent 的任务
// ============================================================================

import { EventEmitter } from 'events';
import type {
  AgentDefinition,
  AgentInstance,
  AgentTask,
  AgentTaskResult,
  TaskContext,
  TaskArtifact,
  DelegationRequest,
  DelegationResponse,
  AgentRole,
} from './types';
import { getAgentRegistry, AgentRegistry } from './agentRegistry';
import type { ModelConfig } from '../../../shared/types';
import type { Tool, ToolContext } from '../../tools/toolRegistry';

// ============================================================================
// 类型定义
// ============================================================================

export interface ExecutorConfig {
  defaultMaxIterations: number;
  defaultTimeout: number;
  streamOutput: boolean;
}

export interface ExecutionContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  onProgress?: (progress: number, step: string) => void;
  onOutput?: (chunk: string) => void;
  onDelegation?: (request: DelegationRequest) => Promise<DelegationResponse>;
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  defaultMaxIterations: 30,
  defaultTimeout: 180000,
  streamOutput: true,
};

// ============================================================================
// AgentExecutor 类
// ============================================================================

export class AgentExecutor extends EventEmitter {
  private config: ExecutorConfig;
  private registry: AgentRegistry;
  private runningTasks: Map<string, AbortController> = new Map();

  constructor(config: Partial<ExecutorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = getAgentRegistry();
  }

  // --------------------------------------------------------------------------
  // 任务执行
  // --------------------------------------------------------------------------

  /**
   * 执行 Agent 任务
   */
  async execute(
    instance: AgentInstance,
    task: AgentTask,
    context: ExecutionContext
  ): Promise<AgentTaskResult> {
    const startTime = Date.now();
    const definition = this.registry.getDefinition(instance.definitionId);

    if (!definition) {
      return this.createErrorResult(task, instance, 'Agent definition not found', 0, Date.now() - startTime);
    }

    // 创建中止控制器
    const abortController = new AbortController();
    this.runningTasks.set(task.id, abortController);

    // 更新实例状态
    this.registry.updateInstanceStatus(instance.id, 'busy', task.id);

    try {
      const result = await this.executeWithDefinition(
        definition,
        instance,
        task,
        context,
        abortController.signal
      );

      // 更新统计
      this.registry.updateInstanceStats(instance.id, {
        success: result.success,
        iterations: result.iterations,
        duration: result.duration,
      });

      // 更新实例状态
      this.registry.updateInstanceStatus(instance.id, 'idle', undefined);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // 更新统计
      this.registry.updateInstanceStats(instance.id, {
        success: false,
        iterations: 0,
        duration: Date.now() - startTime,
      });

      // 更新实例状态
      this.registry.updateInstanceStatus(instance.id, 'error', undefined);

      return this.createErrorResult(task, instance, errorMessage, 0, Date.now() - startTime);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * 使用定义执行任务
   */
  private async executeWithDefinition(
    definition: AgentDefinition,
    instance: AgentInstance,
    task: AgentTask,
    context: ExecutionContext,
    signal: AbortSignal
  ): Promise<AgentTaskResult> {
    const startTime = Date.now();
    const maxIterations = definition.maxIterations || this.config.defaultMaxIterations;
    const timeout = definition.timeout || this.config.defaultTimeout;

    // 构建工具集
    const tools = this.buildTools(definition, context.toolRegistry);

    // 构建系统提示词
    const systemPrompt = this.buildSystemPrompt(definition, task.context);

    // 初始化对话
    const messages: ConversationMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.prompt },
    ];

    let iterations = 0;
    let output = '';
    const toolsUsed: string[] = [];
    const artifacts: TaskArtifact[] = [];
    const delegatedTasks: AgentTaskResult[] = [];

    // 执行循环
    while (iterations < maxIterations) {
      // 检查超时
      if (Date.now() - startTime > timeout) {
        return {
          taskId: task.id,
          agentId: instance.id,
          success: false,
          error: 'Execution timeout',
          iterations,
          duration: Date.now() - startTime,
          toolsUsed,
          artifacts,
          delegatedTasks,
        };
      }

      // 检查中止
      if (signal.aborted) {
        return {
          taskId: task.id,
          agentId: instance.id,
          success: false,
          error: 'Execution cancelled',
          iterations,
          duration: Date.now() - startTime,
          toolsUsed,
          artifacts,
          delegatedTasks,
        };
      }

      iterations++;

      // 调用 LLM
      const response = await this.callLLM(messages, tools, context.modelConfig, definition.temperature);

      // 处理响应
      if (response.type === 'text') {
        const content = response.content || '';
        output += content;
        messages.push({ role: 'assistant', content });

        // 通知输出
        if (content) {
          context.onOutput?.(content);
        }

        // 检查是否完成
        if (this.isTaskComplete(content)) {
          break;
        }
      } else if (response.type === 'tool_call' && response.toolCalls) {
        // 执行工具调用
        for (const toolCall of response.toolCalls) {
          // 检查是否是委派请求
          if (toolCall.name === 'delegate_task' && definition.canDelegate) {
            const delegationResult = await this.handleDelegation(toolCall, context);
            if (delegationResult) {
              delegatedTasks.push(delegationResult);
              messages.push({
                role: 'tool',
                content: JSON.stringify(delegationResult),
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              });
            }
          } else {
            // 普通工具调用
            const tool = tools.get(toolCall.name);
            if (tool) {
              try {
                const params = (toolCall.input || {}) as Record<string, unknown>;
                const result = await tool.execute(params, context.toolContext);
                toolsUsed.push(toolCall.name);

                messages.push({
                  role: 'tool',
                  content: typeof result === 'string' ? result : JSON.stringify(result),
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                });

                // 检查是否产生了产物
                const artifact = this.extractArtifact(toolCall.name, toolCall.input, result);
                if (artifact) {
                  artifacts.push(artifact);
                }
              } catch (error) {
                messages.push({
                  role: 'tool',
                  content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                });
              }
            }
          }
        }

        // 添加助手消息
        messages.push({
          role: 'assistant',
          content: response.assistantContent || '',
        });
      }

      // 报告进度
      context.onProgress?.((iterations / maxIterations) * 100, `Iteration ${iterations}`);
    }

    return {
      taskId: task.id,
      agentId: instance.id,
      success: true,
      output,
      iterations,
      duration: Date.now() - startTime,
      toolsUsed: [...new Set(toolsUsed)],
      artifacts,
      delegatedTasks: delegatedTasks.length > 0 ? delegatedTasks : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // 工具构建
  // --------------------------------------------------------------------------

  /**
   * 构建工具集
   */
  private buildTools(
    definition: AgentDefinition,
    toolRegistry: Map<string, Tool>
  ): Map<string, Tool> {
    const tools = new Map<string, Tool>();

    for (const toolName of definition.availableTools) {
      const tool = toolRegistry.get(toolName);
      if (tool) {
        tools.set(toolName, tool);
      }
    }

    // 如果可以委派，添加委派工具
    if (definition.canDelegate && definition.delegationTargets) {
      tools.set('delegate_task', this.createDelegationTool(definition.delegationTargets));
    }

    return tools;
  }

  /**
   * 创建委派工具
   */
  private createDelegationTool(_targetRoles: string[]): Tool {
    return {
      name: 'delegate_task',
      description: '将子任务委派给其他 Agent 执行',
      generations: ['gen7', 'gen8'],
      requiresPermission: false,
      permissionLevel: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          targetRole: {
            type: 'string',
            description: '目标 Agent 角色',
          },
          task: {
            type: 'string',
            description: '要委派的任务描述',
          },
          priority: {
            type: 'number',
            description: '任务优先级 (1-10)',
          },
          context: {
            type: 'object',
            description: '任务上下文',
          },
        },
        required: ['targetRole', 'task'],
      },
      execute: async (): Promise<{ success: boolean; output?: string }> => {
        // 实际执行在 handleDelegation 中处理
        return { success: true, output: 'Delegation requested' };
      },
    };
  }

  // --------------------------------------------------------------------------
  // LLM 调用
  // --------------------------------------------------------------------------

  /**
   * 调用 LLM
   */
  private async callLLM(
    messages: ConversationMessage[],
    tools: Map<string, Tool>,
    modelConfig: ModelConfig,
    temperature?: number
  ): Promise<{
    type: 'text' | 'tool_call';
    content?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
    assistantContent?: string;
  }> {
    // 构建工具定义
    const toolDefinitions = Array.from(tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // 调用 API
    const response = await fetch(modelConfig.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': modelConfig.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelConfig.model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: temperature ?? 0.3,
        system: messages.find((m) => m.role === 'system')?.content,
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'tool' ? 'user' : m.role,
            content: m.role === 'tool'
              ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
              : m.content,
          })),
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = await response.json();

    // 解析响应
    const textContent = data.content?.find((c: { type: string }) => c.type === 'text');
    const toolUses = data.content?.filter((c: { type: string }) => c.type === 'tool_use') || [];

    if (toolUses.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: toolUses.map((t: { id: string; name: string; input: unknown }) => ({
          id: t.id,
          name: t.name,
          input: t.input,
        })),
        assistantContent: textContent?.text || '',
      };
    }

    return {
      type: 'text',
      content: textContent?.text || '',
    };
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(definition: AgentDefinition, context?: TaskContext): string {
    let prompt = definition.systemPrompt;

    if (context?.projectPath) {
      prompt += `\n\n项目路径: ${context.projectPath}`;
    }

    if (context?.files && context.files.length > 0) {
      prompt += `\n\n相关文件:\n${context.files.map((f) => `- ${f}`).join('\n')}`;
    }

    if (context?.previousResults && context.previousResults.length > 0) {
      prompt += '\n\n前置任务结果:';
      for (const result of context.previousResults) {
        prompt += `\n- ${result.taskId}: ${result.success ? '成功' : '失败'}`;
        if (result.output) {
          prompt += ` - ${result.output.slice(0, 200)}...`;
        }
      }
    }

    return prompt;
  }

  /**
   * 检查任务是否完成
   */
  private isTaskComplete(content: string): boolean {
    const completionIndicators = [
      '任务完成',
      '已完成',
      'Task completed',
      'Done',
      '以上就是',
      '总结如下',
      '执行完毕',
    ];

    const lowerContent = content.toLowerCase();
    return completionIndicators.some((indicator) =>
      lowerContent.includes(indicator.toLowerCase())
    );
  }

  /**
   * 处理委派
   */
  private async handleDelegation(
    toolCall: { id: string; name: string; input: unknown },
    context: ExecutionContext
  ): Promise<AgentTaskResult | null> {
    if (!context.onDelegation) return null;

    const input = toolCall.input as {
      targetRole: string;
      task: string;
      priority?: number;
      context?: TaskContext;
    };

    const request: DelegationRequest = {
      id: `delegation_${Date.now()}`,
      fromAgentId: '', // 由调度器填充
      // targetRole 从工具输入解析，断言为 AgentRole
      targetRole: input.targetRole as AgentRole,
      task: {
        prompt: input.task,
        context: input.context,
        priority: input.priority || 5,
        status: 'pending',
      },
      priority: input.priority || 5,
      context: input.context,
    };

    const response = await context.onDelegation(request);

    if (response.accepted) {
      // 等待委派任务完成
      // 这里简化处理，实际应该异步等待
      return {
        taskId: request.id,
        agentId: response.assignedAgentId || '',
        success: true,
        output: `Task delegated to ${response.assignedAgentId}`,
        iterations: 0,
        duration: 0,
        toolsUsed: [],
      };
    }

    return null;
  }

  /**
   * 提取产物
   */
  private extractArtifact(
    toolName: string,
    input: unknown,
    _result: unknown
  ): TaskArtifact | null {
    const inputObj = input as Record<string, unknown>;

    if (toolName === 'write_file' && inputObj.path) {
      return {
        type: 'file',
        name: inputObj.path as string,
        content: (inputObj.content as string) || '',
      };
    }

    if (toolName === 'edit_file' && inputObj.path) {
      return {
        type: 'code',
        name: inputObj.path as string,
        content: (inputObj.new_str as string) || '',
        metadata: { operation: 'edit' },
      };
    }

    return null;
  }

  /**
   * 创建错误结果
   */
  private createErrorResult(
    task: AgentTask,
    instance: AgentInstance,
    error: string,
    iterations: number,
    duration: number
  ): AgentTaskResult {
    return {
      taskId: task.id,
      agentId: instance.id,
      success: false,
      error,
      iterations,
      duration,
      toolsUsed: [],
    };
  }

  // --------------------------------------------------------------------------
  // 任务控制
  // --------------------------------------------------------------------------

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    const controller = this.runningTasks.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * 获取运行中的任务数
   */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 取消所有运行中的任务
    for (const [taskId] of this.runningTasks) {
      this.cancelTask(taskId);
    }
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let executorInstance: AgentExecutor | null = null;

export function getAgentExecutor(): AgentExecutor {
  if (!executorInstance) {
    executorInstance = new AgentExecutor();
  }
  return executorInstance;
}
