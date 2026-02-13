// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// Enhanced with unified pipeline (T4)
// ============================================================================

import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';
import {
  getSubagentPipeline,
  type SubagentExecutionContext,
  type ToolExecutionRequest,
} from './subagentPipeline';
import type { AgentDefinition, DynamicAgentConfig } from './agentDefinition';
import {
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from './agentDefinition';
import type { PermissionPreset } from '../services/core/permissionPresets';
import { PROVIDER_REGISTRY } from '../model/modelRouter';
import {
  normalizeImageData,
  type ImageAttachmentInput,
  type NormalizedImageData,
} from '../utils/imageUtils';
import { compactSubagentMessages } from './subagentCompaction';
import { SUBAGENT_COMPACTION } from '../../shared/constants';

const logger = createLogger('SubagentExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  availableTools: string[];
  maxIterations?: number;
  /** Permission preset for pipeline integration */
  permissionPreset?: PermissionPreset;
  /** Maximum budget for this subagent */
  maxBudget?: number;
  /** P3: Maximum execution time in milliseconds */
  maxExecutionTimeMs?: number;
}

// ============================================================================
// P3: 默认执行超时配置（按 Agent 类型）
// ============================================================================

const DEFAULT_EXECUTION_TIMEOUT: Record<string, number> = {
  // 探索类（快速返回）
  'Code Explore Agent': 30_000,       // 30 秒
  'Web Search Agent': 30_000,
  'Document Reader Agent': 30_000,

  // 审查类（适中）
  'Code Reviewer': 60_000,            // 60 秒
  '视觉理解 Agent': 45_000,

  // 执行类（可能需要更多时间）
  'Coder': 90_000,                    // 90 秒
  'Debugger': 90_000,
  'Test Engineer': 90_000,
  'Code Refactorer': 60_000,
  'DevOps Engineer': 60_000,
  'Technical Writer': 45_000,

  // 规划类
  'Plan Agent': 60_000,
  'Software Architect': 60_000,

  // 其他
  'General Purpose Agent': 90_000,
  'Bash Executor Agent': 45_000,
  'MCP Connector Agent': 60_000,
  '视觉处理 Agent': 60_000,

  // 默认值
  'default': 60_000,                  // 60 秒
};

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  toolsUsed: string[];
  iterations: number;
  /** Cost incurred by this subagent */
  cost?: number;
  /** Agent ID from pipeline */
  agentId?: string;
}

interface SubagentContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  /** Attachments (images, files) to include in the first message */
  attachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** 父工具调用 ID，用于标识消息来自哪个 subagent */
  parentToolUseId?: string;
  /** AbortSignal 用于取消任务执行 */
  abortSignal?: AbortSignal;
}

// ----------------------------------------------------------------------------
// Subagent Executor
// ----------------------------------------------------------------------------

export class SubagentExecutor {
  private modelRouter: ModelRouter;

  constructor() {
    this.modelRouter = new ModelRouter();
  }

  /**
   * Execute a subagent with a specific prompt and limited tools
   * Now integrates with SubagentPipeline for permission/budget/audit
   */
  async execute(
    prompt: string,
    config: SubagentConfig,
    context: SubagentContext
  ): Promise<SubagentResult> {
    const maxIterations = config.maxIterations || 10;
    const toolsUsed: string[] = [];
    let iterations = 0;
    let finalOutput = '';

    // P3: 计算执行超时时间
    const timeout = config.maxExecutionTimeMs
      || DEFAULT_EXECUTION_TIMEOUT[config.name]
      || DEFAULT_EXECUTION_TIMEOUT['default'];
    const startTime = Date.now();

    // Create pipeline context
    const pipeline = getSubagentPipeline();
    const dynamicConfig: DynamicAgentConfig = {
      name: config.name,
      systemPrompt: config.systemPrompt,
      tools: config.availableTools,
      maxIterations: config.maxIterations,
      permissionPreset: config.permissionPreset || 'development',
      maxBudget: config.maxBudget,
    };
    const pipelineContext = pipeline.createContext(
      dynamicConfig,
      context.toolContext.workingDirectory
    );

    // Filter tools to only those allowed for this subagent
    const allowedTools = this.filterTools(config.availableTools, context.toolRegistry);

    // Check if the model supports tool calls
    const providerConfig = PROVIDER_REGISTRY[context.modelConfig.provider];
    const modelInfo = providerConfig?.models.find((m: { id: string; supportsTool?: boolean }) => m.id === context.modelConfig.model);
    const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown

    // Only provide tool definitions if the model supports them
    const toolDefinitions = supportsTool ? allowedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      generations: tool.generations,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    })) : [];

    if (!supportsTool && allowedTools.length > 0) {
      logger.warn(`[${config.name}] Model ${context.modelConfig.model} does not support tool calls, tools will be ignored`);
    }

    // MessageContent type matching modelRouter.ts
    type MessageContent = {
      type: 'text' | 'image';
      text?: string;
      source?: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    };

    // Build messages with multimodal support for images
    const messages: Array<{ role: string; content: string | MessageContent[] }> = [
      { role: 'system', content: config.systemPrompt },
    ];

    // Build user message content (potentially multimodal)
    // 使用 normalizeImageData 统一处理图片数据格式
    const imageAttachments = context.attachments?.filter(
      att => att.type === 'image' || att.category === 'image'
    ) || [];

    if (imageAttachments.length > 0) {
      // Multimodal message with images
      const multimodalContent: MessageContent[] = [];

      // Add text first
      multimodalContent.push({ type: 'text', text: prompt });

      // Add images using normalized data
      let successCount = 0;
      for (const img of imageAttachments) {
        // 使用统一的图片数据规范化函数
        // 这会正确处理：
        // 1. data URL (data:image/png;base64,xxx) - 提取纯 base64
        // 2. 纯 base64 字符串 - 直接使用
        // 3. 文件路径 - 读取文件并转换为 base64
        const normalized = normalizeImageData(img.data, img.path, img.mimeType);

        if (normalized) {
          multimodalContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: normalized.mimeType,
              data: normalized.base64,
            }
          });
          successCount++;

          // 如果图片有路径，添加路径信息供工具使用
          if (normalized.path || img.path) {
            multimodalContent.push({
              type: 'text',
              text: `📍 图片文件路径: ${normalized.path || img.path}`,
            });
          }

          logger.debug(`[${config.name}] Added image`, {
            mimeType: normalized.mimeType,
            dataLength: normalized.base64.length,
            path: normalized.path,
          });
        } else {
          logger.warn(`[${config.name}] Failed to normalize image data`, {
            hasData: !!img.data,
            dataLength: img.data?.length,
            path: img.path,
          });
        }
      }

      messages.push({ role: 'user', content: multimodalContent });
      logger.info(`[${config.name}] Built multimodal message with ${successCount}/${imageAttachments.length} images`);
    } else {
      // Text-only message
      messages.push({ role: 'user', content: prompt });
    }

    logger.info(`[${config.name}] Starting with ${toolDefinitions.length} tools (agentId: ${pipelineContext.agentId}, supportsTool: ${supportsTool})`);

    // 发射 subagent 初始化事件
    const parentToolUseId = context.parentToolUseId;
    if (parentToolUseId && context.toolContext.emit) {
      context.toolContext.emit('agent_thinking', {
        message: `Subagent [${config.name}] starting...`,
        agentId: pipelineContext.agentId,
        parentToolUseId,
      });
    }

    try {
      // Initial budget check
      const budgetCheck = pipeline.checkBudget(pipelineContext);
      if (!budgetCheck.allowed) {
        pipeline.completeContext(pipelineContext.agentId, false, budgetCheck.reason);
        return {
          success: false,
          output: '',
          error: budgetCheck.reason,
          toolsUsed: [],
          iterations: 0,
          agentId: pipelineContext.agentId,
        };
      }

      while (iterations < maxIterations) {
        iterations++;
        logger.info(`[${config.name}] Iteration ${iterations}`);

        // 检查 AbortSignal 取消状态
        if (context.abortSignal?.aborted) {
          logger.info(`[${config.name}] Execution cancelled by AbortSignal`);
          pipeline.completeContext(pipelineContext.agentId, false, 'Cancelled');
          return {
            success: false,
            output: finalOutput || '',
            error: '任务已取消',
            toolsUsed: [...new Set(toolsUsed)],
            iterations,
            agentId: pipelineContext.agentId,
          };
        }

        // P3: 超时检查
        const elapsed = Date.now() - startTime;
        if (elapsed > timeout) {
          logger.warn(`[${config.name}] Execution timeout after ${elapsed}ms (limit: ${timeout}ms)`, {
            iterations,
            toolsUsed: [...new Set(toolsUsed)],
          });
          pipeline.completeContext(pipelineContext.agentId, false, 'Execution timeout');
          return {
            success: false,
            output: finalOutput || '',
            error: `执行超时 (${Math.round(timeout / 1000)}秒)，已完成 ${iterations} 次迭代`,
            toolsUsed: [...new Set(toolsUsed)],
            iterations,
            agentId: pipelineContext.agentId,
          };
        }

        // Check budget before each iteration
        const iterBudgetCheck = pipeline.checkBudget(pipelineContext);
        if (!iterBudgetCheck.allowed) {
          logger.warn(`[${config.name}] Budget exceeded at iteration ${iterations}`);
          break;
        }

        // Auto-compaction: truncate old messages if approaching context limit
        if (iterations > SUBAGENT_COMPACTION.SKIP_FIRST_ITERATIONS) {
          compactSubagentMessages(messages, context.modelConfig.model);
        }

        // Call model
        const response = await this.modelRouter.inference(
          messages,
          toolDefinitions,
          context.modelConfig,
          () => {} // No streaming for subagents
        );

        // Note: Token usage tracking would require ModelResponse to include usage data
        // For now, we skip token usage recording as the ModelRouter doesn't expose it
        // TODO: Enhance ModelRouter to return token usage for budget tracking

        // Handle text response - subagent is done
        if (response.type === 'text' && response.content) {
          finalOutput = response.content;
          break;
        }

        // Handle tool calls
        if (response.type === 'tool_use' && response.toolCalls) {
          const toolResults: string[] = [];

          for (const toolCall of response.toolCalls) {
            const tool = allowedTools.find((t) => t.name === toolCall.name);
            if (!tool) {
              toolResults.push(`Error: Tool ${toolCall.name} not available`);
              continue;
            }

            // Build tool execution request for pipeline
            const toolRequest: ToolExecutionRequest = {
              toolName: toolCall.name,
              permissionLevel: tool.permissionLevel,
              path: toolCall.arguments.path as string | undefined
                || toolCall.arguments.file_path as string | undefined,
              command: toolCall.arguments.command as string | undefined,
              url: toolCall.arguments.url as string | undefined,
            };

            // Check permission via pipeline
            const permCheck = pipeline.preExecutionCheck(pipelineContext, toolRequest);
            if (!permCheck.allowed) {
              toolResults.push(`Error: Permission denied for ${toolCall.name}: ${permCheck.reason}`);
              logger.warn(`[${config.name}] Tool ${toolCall.name} denied: ${permCheck.reason}`);
              continue;
            }

            // Log warnings
            for (const warning of permCheck.warnings) {
              logger.warn(`[${config.name}] Tool warning: ${warning}`);
            }

            toolsUsed.push(toolCall.name);
            pipeline.recordToolUsage(pipelineContext, toolCall.name);
            logger.info(`[${config.name}] Executing tool: ${toolCall.name}`);

            // 发射 subagent 工具调用开始事件
            if (parentToolUseId && context.toolContext.emit) {
              context.toolContext.emit('tool_call_start', {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                parentToolUseId,
              });
            }

            const toolStartTime = Date.now();
            try {
              const result = await tool.execute(toolCall.arguments, context.toolContext);
              const toolDuration = Date.now() - toolStartTime;
              toolResults.push(
                `Tool ${toolCall.name}: ${result.success ? 'Success' : 'Failed'}\n${result.output || result.error || ''}`
              );

              // 发射 subagent 工具调用结束事件
              if (parentToolUseId && context.toolContext.emit) {
                context.toolContext.emit('tool_call_end', {
                  toolCallId: toolCall.id,
                  success: result.success,
                  output: result.output,
                  error: result.error,
                  duration: toolDuration,
                  parentToolUseId,
                });
              }
            } catch (error) {
              const toolDuration = Date.now() - toolStartTime;
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              toolResults.push(
                `Tool ${toolCall.name}: Error - ${errorMessage}`
              );

              // 发射 subagent 工具调用错误事件
              if (parentToolUseId && context.toolContext.emit) {
                context.toolContext.emit('tool_call_end', {
                  toolCallId: toolCall.id,
                  success: false,
                  error: errorMessage,
                  duration: toolDuration,
                  parentToolUseId,
                });
              }
            }
          }

          // Add tool results to messages
          messages.push({
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
          });
          messages.push({
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
          });

          continue;
        }

        // No response, break
        break;
      }

      // Get final cost
      const budgetStatus = pipeline.getBudgetStatus(pipelineContext);
      pipeline.completeContext(pipelineContext.agentId, true);

      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        cost: budgetStatus.subagentCost,
        agentId: pipelineContext.agentId,
      };
    } catch (error) {
      pipeline.completeContext(
        pipelineContext.agentId,
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        agentId: pipelineContext.agentId,
      };
    }
  }

  /**
   * Execute from an AgentDefinition (declarative mode)
   */
  async executeFromDefinition(
    prompt: string,
    agentDef: AgentDefinition,
    context: SubagentContext
  ): Promise<SubagentResult> {
    // Convert AgentDefinition to SubagentConfig using helper functions
    const config: SubagentConfig = {
      name: agentDef.name,
      systemPrompt: getAgentPrompt(agentDef),
      availableTools: getAgentTools(agentDef),
      maxIterations: getAgentMaxIterations(agentDef),
      permissionPreset: getAgentPermissionPreset(agentDef),
      maxBudget: getAgentMaxBudget(agentDef),
    };

    return this.execute(prompt, config, context);
  }

  private filterTools(
    allowedToolNames: string[],
    toolRegistry: Map<string, Tool>
  ): Tool[] {
    const tools: Tool[] = [];
    const missing: string[] = [];
    for (const name of allowedToolNames) {
      const tool = toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
      } else {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      logger.warn(`filterTools: ${missing.length} tools not found in registry: ${missing.join(', ')} (registry size: ${toolRegistry.size})`);
    }
    return tools;
  }
}

// Singleton instance
let subagentExecutor: SubagentExecutor | null = null;

export function getSubagentExecutor(): SubagentExecutor {
  if (!subagentExecutor) {
    subagentExecutor = new SubagentExecutor();
  }
  return subagentExecutor;
}
