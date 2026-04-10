// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// Enhanced with unified pipeline (T4)
// ============================================================================

import type { Message, MessageAttachment, ModelConfig, ToolCall } from '../../shared/types';
import type { SwarmAgentContextSnapshot } from '../../shared/types/swarm';
import type { Tool, ToolContext } from '../tools/types';
import type { ModelMessage as ProviderModelMessage } from '../model/types';
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
import { CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, SUBAGENT_COMPACTION } from '../../shared/constants';
import { createTimedAbortController, createChildAbortController } from './shutdownProtocol';
import { getPlanApprovalGate } from './planApproval';
import { getSpawnGuard } from './spawnGuard';
import { buildChildContext, type ParentContext } from './childContext';
import { AgentTask, type SidecarMetadata } from './agentTask';
import { estimateTokens } from '../context/tokenEstimator';
import { getWarningLevel } from '../../shared/types/contextHealth';
import { generateMessageId } from '../../shared/utils/id';
import { getSubagentContextStore } from '../context/subagentContextStore';
import { applyInterventionsToMessages } from '../context/contextInterventionHelpers';
import { getContextInterventionState } from '../context/contextInterventionState';
import type { ContextProvenanceCategory } from '../../shared/types/contextView';

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
  /** Whether high-risk operations require plan approval from coordinator */
  requirePlanApproval?: boolean;
  /** Coordinator agent ID for plan approval (defaults to 'coordinator') */
  coordinatorId?: string;
}

// ============================================================================
// P3: 默认执行超时配置（按 Agent 类型）
// ============================================================================

const DEFAULT_EXECUTION_TIMEOUT: Record<string, number> = {
  // 探索类（需要读文件+搜索，API 降级时需要更多时间）
  'Code Explore Agent': 60_000,       // 60 秒（原 30s，API 不稳定时太短）
  'Web Search Agent': 60_000,
  'Document Reader Agent': 45_000,

  // 审查类（需要多轮分析）
  'Code Reviewer': 90_000,            // 90 秒（原 60s）
  '视觉理解 Agent': 60_000,

  // 执行类（可能需要更多时间）
  'Coder': 120_000,                   // 120 秒（原 90s）
  'Debugger': 120_000,
  'Test Engineer': 120_000,
  'Code Refactorer': 90_000,
  'DevOps Engineer': 90_000,
  'Technical Writer': 60_000,

  // 规划类
  'Plan Agent': 90_000,
  'Software Architect': 90_000,

  // 其他
  'General Purpose Agent': 120_000,
  'Bash Executor Agent': 60_000,
  'MCP Connector Agent': 90_000,
  '视觉处理 Agent': 90_000,

  // 默认值
  'default': 90_000,                  // 90 秒（原 60s）
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
  /** Lightweight context snapshot for swarm UI */
  contextSnapshot?: SwarmAgentContextSnapshot;
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
  /** SpawnGuard agent ID — used to drain message queue for send_input */
  spawnGuardId?: string;
  /** External task agent ID (e.g. DAG task ID) for context observability */
  executionAgentId?: string;
  /** Parent context for child context inheritance */
  parentContext?: ParentContext;
  /** Worktree path if agent is running in an isolated git worktree */
  worktreePath?: string;
  /** Optional callback for lightweight context updates */
  onContextSnapshot?: (snapshot: SwarmAgentContextSnapshot) => void;
}

type MessageContent = {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

type RuntimeMessage = {
  id: string;
  role: Message['role'];
  content: string | MessageContent[];
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  observation?: {
    category?: ContextProvenanceCategory;
    sourceDetail?: string;
    sourceKind?: 'message' | 'tool_result' | 'dependency_carry_over' | 'attachment' | 'compression_survivor' | 'system_anchor';
    layer?: string;
    toolCallId?: string;
  };
};

function flattenMessageContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text' && part.text) return part.text;
      if (part.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeAttachmentCategory(category?: string, type?: string): MessageAttachment['category'] {
  if (!category) {
    return type === 'image' ? 'image' : 'other';
  }
  const validCategories = new Set<MessageAttachment['category']>([
    'image',
    'pdf',
    'excel',
    'code',
    'text',
    'data',
    'document',
    'html',
    'folder',
    'other',
  ]);
  return validCategories.has(category as MessageAttachment['category'])
    ? category as MessageAttachment['category']
    : (type === 'image' ? 'image' : 'other');
}

function buildMessageAttachments(
  attachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>,
): MessageAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => ({
    id: `${Date.now()}-${index}-${attachment.name ?? 'attachment'}`,
    type: attachment.type === 'image' ? 'image' : 'file',
    category: normalizeAttachmentCategory(attachment.category, attachment.type),
    name: attachment.name || `attachment-${index + 1}`,
    size: attachment.data?.length ?? 0,
    mimeType: attachment.mimeType || 'application/octet-stream',
    data: attachment.data,
    path: attachment.path,
  }));
}

function buildContextSnapshot(
  messages: RuntimeMessage[],
  model: string,
  toolsUsed: string[],
  attachments?: Array<{ name?: string }>,
): SwarmAgentContextSnapshot {
  const maxTokens = CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW;
  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: flattenMessageContent(message.content),
  }));
  const currentTokens = normalizedMessages.reduce((sum, message) => (
    sum + 4 + estimateTokens(message.content)
  ), 3);
  const usagePercent = maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 1000) / 10 : 0;

  return {
    currentTokens,
    maxTokens,
    usagePercent,
    messageCount: normalizedMessages.length,
    warningLevel: getWarningLevel(usagePercent),
    lastUpdated: Date.now(),
    tools: [...new Set(toolsUsed)].slice(-6),
    attachments: [...new Set((attachments || []).map((attachment) => attachment.name).filter(Boolean) as string[])].slice(0, 6),
    previews: normalizedMessages.slice(-3).map((message) => ({
      role: message.role,
      contentPreview: message.content.length > 120
        ? `${message.content.slice(0, 120)}...`
        : message.content,
      tokens: estimateTokens(message.content),
    })),
    truncatedMessages: normalizedMessages.filter((message) => message.content.includes('[truncated]')).length,
  };
}

function createRuntimeMessage(
  message: Omit<RuntimeMessage, 'id' | 'timestamp'> & Partial<Pick<RuntimeMessage, 'id' | 'timestamp'>>,
): RuntimeMessage {
  return {
    id: message.id || generateMessageId(),
    timestamp: message.timestamp || Date.now(),
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    toolCalls: message.toolCalls,
    observation: message.observation,
  };
}

function materializeObservedMessages(messages: RuntimeMessage[]): Message[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: flattenMessageContent(message.content),
    attachments: message.attachments,
    toolCalls: message.toolCalls,
    timestamp: message.timestamp,
  }));
}

function buildObservation(
  category: ContextProvenanceCategory,
  sourceDetail?: string,
  extras?: Partial<NonNullable<RuntimeMessage['observation']>>,
): NonNullable<RuntimeMessage['observation']> {
  return {
    category,
    sourceDetail,
    ...extras,
  };
}

function buildInferenceMessages(messages: RuntimeMessage[]): ProviderModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          })),
          toolCallText: message.toolCalls
            .map((toolCall) => `Calling ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)
            .join('\n'),
        }
      : {}),
  }));
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
    // Create AgentTask for lifecycle tracking
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskMetadata: SidecarMetadata = {
      agentType: config.name,
      worktreePath: context.worktreePath,
      parentSessionId: context.toolContext.sessionId || 'unknown',
      spawnTime: Date.now(),
      model: context.modelConfig.model,
      toolPool: config.availableTools,
    };
    const agentTask = new AgentTask(agentId, taskMetadata);
    agentTask.register();
    agentTask.start();

    const maxIterations = config.maxIterations || 10;
    const toolsUsed: string[] = [];
    let iterations = 0;
    let finalOutput = '';

    // P3: 计算执行超时时间
    const timeout = config.maxExecutionTimeMs
      || DEFAULT_EXECUTION_TIMEOUT[config.name]
      || DEFAULT_EXECUTION_TIMEOUT['default'];
    const startTime = Date.now();

    // Create per-execution AbortController with timeout
    const { controller: timeoutController, cleanup: cleanupTimer } = createTimedAbortController(
      timeout,
      { label: config.name }
    );
    // Create child controller: parent abort propagates down, child abort doesn't affect parent.
    // This replaces combineAbortSignals which was bidirectional (child abort → parent affected).
    const effectiveController = context.abortSignal
      ? (() => {
          // Parent = external signal's controller. Child = our timeout controller.
          // We need a child that aborts on either parent OR timeout.
          const parentController = new AbortController();
          // Propagate external signal to our parent proxy
          context.abortSignal.addEventListener('abort', () => {
            parentController.abort(context.abortSignal!.reason);
          }, { once: true });
          // Propagate timeout to our parent proxy
          timeoutController.signal.addEventListener('abort', () => {
            parentController.abort(timeoutController.signal.reason);
          }, { once: true });
          // Create child that parent can abort, but child abort doesn't propagate up
          return createChildAbortController(parentController);
        })()
      : timeoutController;
    const effectiveSignal = effectiveController.signal;

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
    let effectiveToolNames = config.availableTools;

    // Only use buildChildContext when we have parent context available
    // This is additive — if no parent context, existing logic unchanged
    if (context.parentContext) {
      const childCtx = buildChildContext(
        {
          agentType: config.name,
          allowedTools: config.availableTools,
          readOnly: (config.permissionPreset as string) === 'review' || (config.permissionPreset as string) === 'audit',
        },
        context.parentContext,
      );
      // Use child context's tool pool (intersection with parent)
      // Only override if childCtx provides a different (narrower) pool
      if (childCtx.toolPool.length > 0) {
        effectiveToolNames = childCtx.toolPool;
      }
    }

    const allowedTools = this.filterTools(effectiveToolNames, context.toolRegistry);

    // Check if the model supports tool calls
    const providerConfig = PROVIDER_REGISTRY[context.modelConfig.provider];
    const modelInfo = providerConfig?.models.find((m: { id: string; supportsTool?: boolean }) => m.id === context.modelConfig.model);
    const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown

    // Only provide tool definitions if the model supports them
    const toolDefinitions = supportsTool ? allowedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    })) : [];

    if (!supportsTool && allowedTools.length > 0) {
      logger.warn(`[${config.name}] Model ${context.modelConfig.model} does not support tool calls, tools will be ignored`);
    }

    const subagentContextStore = getSubagentContextStore();
    const sessionId = ((context.toolContext as ToolContext & { sessionId?: string }).sessionId || '').trim() || 'unknown';
    const observabilityAgentId = context.executionAgentId || context.spawnGuardId || pipelineContext.agentId;

    // Build messages with multimodal support for images
    const messages: RuntimeMessage[] = [
      createRuntimeMessage({
        role: 'system',
        content: config.systemPrompt,
        observation: buildObservation(
          /fork context|shared discoveries|shared context|dependency|carry-over/i.test(config.systemPrompt)
            ? 'dependency_carry_over'
            : 'system_anchor',
          'system_prompt',
          {
            sourceKind: /fork context|shared discoveries|shared context|dependency|carry-over/i.test(config.systemPrompt)
              ? 'dependency_carry_over'
              : 'system_anchor',
            layer: 'system_prompt',
          },
        ),
      }),
    ];
    let latestContextSnapshot = buildContextSnapshot(
      messages,
      context.modelConfig.model,
      toolsUsed,
      context.attachments,
    );
    const emitContextSnapshot = (messageOverride?: RuntimeMessage[]): void => {
      const effectiveMessages = messageOverride || messages;
      latestContextSnapshot = buildContextSnapshot(
        effectiveMessages,
        context.modelConfig.model,
        toolsUsed,
        context.attachments,
      );
      context.onContextSnapshot?.(latestContextSnapshot);
      const annotations = Object.fromEntries(
        effectiveMessages
          .filter((message) => message.observation?.category || message.observation?.sourceDetail)
          .map((message) => [message.id, {
            category: message.observation?.category,
            sourceDetail: message.observation?.sourceDetail,
            agentId: observabilityAgentId,
            sourceKind: message.observation?.sourceKind,
            layer: message.observation?.layer,
            toolCallId: message.observation?.toolCallId,
          }]),
      );
      subagentContextStore.upsert({
        sessionId,
        agentId: observabilityAgentId,
        messages: materializeObservedMessages(effectiveMessages),
        snapshot: latestContextSnapshot,
        annotations,
        maxTokens: latestContextSnapshot.maxTokens,
        updatedAt: Date.now(),
      });
    };
    const pushObservabilityMessage = (_message: Message): void => {};

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

      messages.push(createRuntimeMessage({
        role: 'user',
        content: multimodalContent,
        attachments: buildMessageAttachments(context.attachments),
        observation: buildObservation(
          imageAttachments.length > 0 ? 'attachment' : 'recent_turn',
          imageAttachments[0]?.name || 'user_prompt',
          {
            sourceKind: imageAttachments.length > 0 ? 'attachment' : 'message',
            layer: imageAttachments.length > 0 ? 'attachment_input' : 'user_turn',
          },
        ),
      }));
      pushObservabilityMessage({
        id: generateMessageId(),
        role: 'user',
        content: prompt,
        attachments: buildMessageAttachments(context.attachments),
        timestamp: Date.now(),
      });
      logger.info(`[${config.name}] Built multimodal message with ${successCount}/${imageAttachments.length} images`);
    } else {
      // Text-only message
      messages.push(createRuntimeMessage({
        role: 'user',
        content: prompt,
        attachments: buildMessageAttachments(context.attachments),
        observation: buildObservation(
          context.attachments?.length ? 'attachment' : 'recent_turn',
          context.attachments?.[0]?.name || 'user_prompt',
          {
            sourceKind: context.attachments?.length ? 'attachment' : 'message',
            layer: context.attachments?.length ? 'attachment_input' : 'user_turn',
          },
        ),
      }));
      pushObservabilityMessage({
        id: generateMessageId(),
        role: 'user',
        content: prompt,
        attachments: buildMessageAttachments(context.attachments),
        timestamp: Date.now(),
      });
    }
    emitContextSnapshot();

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
        agentTask.fail(budgetCheck.reason || 'budget exceeded');
        return {
          success: false,
          output: '',
          error: budgetCheck.reason,
          toolsUsed: [],
          iterations: 0,
          agentId: agentTask.id,
          contextSnapshot: latestContextSnapshot,
        };
      }

      while (iterations < maxIterations) {
        iterations++;
        logger.info(`[${config.name}] Iteration ${iterations}`);

        // Check abort signal (covers both external cancel and timeout)
        if (effectiveSignal.aborted) {
          const reason = effectiveSignal.reason === 'timeout' ? 'timeout' : 'cancelled';
          logger.info(`[${config.name}] Execution ${reason} by AbortSignal after ${Date.now() - startTime}ms`);
          cleanupTimer();
          pipeline.completeContext(pipelineContext.agentId, false, reason);
          const errorMsg = reason === 'timeout'
            ? `执行超时 (${Math.round(timeout / 1000)}秒)，已完成 ${iterations} 次迭代`
            : '任务已取消';
          agentTask.fail(errorMsg);
          return {
            success: false,
            output: finalOutput || '',
            error: errorMsg,
            toolsUsed: [...new Set(toolsUsed)],
            iterations,
            agentId: agentTask.id,
            contextSnapshot: latestContextSnapshot,
          };
        }

        // Drain structured message queue (mid-loop injection)
        if (context.spawnGuardId) {
          const pendingMessages = getSpawnGuard().drainMessages(context.spawnGuardId);
          if (pendingMessages.length > 0) {
            for (const msg of pendingMessages) {
              if (msg.type === 'shutdown_request') {
                // Graceful shutdown: break after current iteration
                logger.info(`[${config.name}] Received shutdown_request from ${msg.from}`);
                break;
              }
              // Text and other message types: inject into conversation
              const prefix = msg.type === 'text' ? 'Parent agent message' : `Agent message (${msg.type})`;
              messages.push(createRuntimeMessage({
                role: 'user',
                content: `[${prefix}]: ${msg.payload}`,
                observation: buildObservation('dependency_carry_over', msg.from, {
                  sourceKind: 'dependency_carry_over',
                  layer: 'carry_over',
                }),
              }));
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'user',
                content: `[${prefix}]: ${msg.payload}`,
                timestamp: Date.now(),
              });
            }
            logger.info(`[${config.name}] Processed ${pendingMessages.length} queued messages`);
            emitContextSnapshot();
          }
        }

        // Check budget before each iteration
        const iterBudgetCheck = pipeline.checkBudget(pipelineContext);
        if (!iterBudgetCheck.allowed) {
          logger.warn(`[${config.name}] Budget exceeded at iteration ${iterations}`);
          break;
        }

        // Auto-compaction: truncate old messages if approaching context limit
        if (iterations > SUBAGENT_COMPACTION.SKIP_FIRST_ITERATIONS) {
          if (compactSubagentMessages(messages, context.modelConfig.model)) {
            for (const message of messages) {
              if (typeof message.content === 'string' && message.content.includes('[truncated]')) {
                message.observation = buildObservation('compression_survivor', 'subagent_compaction', {
                  sourceKind: 'compression_survivor',
                  layer: 'subagent_compaction',
                });
              }
            }
            emitContextSnapshot();
          }
        }

        // Call model
        const effectiveInterventions = getContextInterventionState().getEffectiveSnapshot(
          sessionId,
          observabilityAgentId,
        );
        const inferenceMessages = applyInterventionsToMessages(messages, effectiveInterventions);

        const response = await this.modelRouter.inference(
          buildInferenceMessages(inferenceMessages),
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
          messages.push(createRuntimeMessage({
            role: 'assistant',
            content: response.content,
            observation: buildObservation('recent_turn', 'assistant_response', {
              sourceKind: 'message',
              layer: 'assistant_turn',
            }),
          }));
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: response.content,
            timestamp: Date.now(),
          });
          emitContextSnapshot();
          break;
        }

        // Handle tool calls
        if (response.type === 'tool_use' && response.toolCalls) {
          const toolResults: string[] = [];
          const assistantToolCalls: ToolCall[] = response.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }));
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
            toolCalls: assistantToolCalls,
            timestamp: Date.now(),
          });

          for (const toolCall of response.toolCalls) {
            const tool = allowedTools.find((t) => t.name === toolCall.name);
            if (!tool) {
              toolResults.push(`Error: Tool ${toolCall.name} not available`);
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: `Error: Tool ${toolCall.name} not available`,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error: `Tool ${toolCall.name} not available`,
                }],
                timestamp: Date.now(),
              });
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
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: `Error: Permission denied for ${toolCall.name}: ${permCheck.reason}`,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error: `Permission denied for ${toolCall.name}: ${permCheck.reason}`,
                }],
                timestamp: Date.now(),
              });
              continue;
            }

            // Log warnings
            for (const warning of permCheck.warnings) {
              logger.warn(`[${config.name}] Tool warning: ${warning}`);
            }

            // Plan approval gate for high-risk operations
            if (config.requirePlanApproval) {
              const gate = getPlanApprovalGate();
              const risk = gate.assessRisk(toolRequest, context.toolContext.workingDirectory);
              if (risk.level !== 'low') {
                const approval = await gate.submitForApproval({
                  agentId: pipelineContext.agentId,
                  agentName: config.name,
                  coordinatorId: config.coordinatorId || 'coordinator',
                  plan: `Tool: ${toolCall.name}\nArgs: ${JSON.stringify(toolCall.arguments)}\nRisk: ${risk.reasons.join(', ')}`,
                  risk,
                });
                if (!approval.approved) {
                  toolResults.push(`Tool ${toolCall.name}: Blocked by plan approval — ${approval.feedback || 'rejected'}`);
                  logger.info(`[${config.name}] Tool ${toolCall.name} blocked by plan approval`);
                  pushObservabilityMessage({
                    id: generateMessageId(),
                    role: 'tool',
                    content: `Tool ${toolCall.name}: Blocked by plan approval — ${approval.feedback || 'rejected'}`,
                    toolResults: [{
                      toolCallId: toolCall.id,
                      success: false,
                      error: `Blocked by plan approval: ${approval.feedback || 'rejected'}`,
                    }],
                    timestamp: Date.now(),
                  });
                  continue;
                }
              }
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
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: result.output || result.error || '',
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: result.success,
                  output: result.output,
                  error: result.error,
                  duration: toolDuration,
                  outputPath: result.outputPath,
                  metadata: result.metadata,
                }],
                timestamp: Date.now(),
              });

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
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: errorMessage,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error: errorMessage,
                  duration: toolDuration,
                }],
                timestamp: Date.now(),
              });

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
          messages.push(createRuntimeMessage({
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
            toolCalls: assistantToolCalls,
            observation: buildObservation(
              'tool_result',
              assistantToolCalls.map((toolCall) => toolCall.name).join(', '),
              {
                sourceKind: 'tool_result',
                layer: 'assistant_tool_call',
              },
            ),
          }));
          messages.push(createRuntimeMessage({
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
            observation: buildObservation(
              'tool_result',
              response.toolCalls.map((toolCall) => toolCall.name).join(', '),
              {
                sourceKind: 'tool_result',
                layer: 'tool_result_summary',
              },
            ),
          }));
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
            timestamp: Date.now(),
          });
          emitContextSnapshot();

          continue;
        }

        // No response, break
        break;
      }

      // Get final cost
      cleanupTimer();
      const budgetStatus = pipeline.getBudgetStatus(pipelineContext);
      pipeline.completeContext(pipelineContext.agentId, true);

      // Record final output in transcript and close AgentTask lifecycle
      agentTask.appendTranscript({
        role: 'assistant',
        content: finalOutput || 'Subagent completed without output',
        timestamp: Date.now(),
      });
      agentTask.stop();

      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        cost: budgetStatus.subagentCost,
        agentId: agentTask.id,
        contextSnapshot: latestContextSnapshot,
      };
    } catch (error) {
      cleanupTimer();
      pipeline.completeContext(
        pipelineContext.agentId,
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );

      agentTask.fail(error instanceof Error ? error.message : String(error));
      throw error; // re-throw to preserve existing error handling
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
