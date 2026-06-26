// ============================================================================
// Subagent Executor Telemetry Helpers
// ============================================================================
// 从 SubagentExecutor 抽出的纯遥测构造逻辑：每轮 modelCall 构造、detached turn 记录、
// 中途队列消息注入。均为纯函数（输入→输出 / 经回调产生副作用），不依赖实例状态。

import type { ModelConfig } from '../../shared/contract';
import type { AgentMessage } from './spawnGuard';
import type { ModelMessage as ProviderModelMessage } from '../model/types';
import type { ModelRouter } from '../model/modelRouter';
import type { TelemetryModelCall } from '../../shared/contract/telemetry';
import type { TelemetryCollector } from '../telemetry/telemetryCollector';
import { estimateTokens } from '../context/tokenEstimator';
import { generateMessageId } from '../../shared/utils/id';
import {
  buildModelCompletionSummary,
  buildModelPromptSummary,
  buildObservation,
  createRuntimeMessage,
  stringifyModelContent,
  type RuntimeMessage,
} from './subagentExecutorProjection';

type ModelInferenceResponse = Awaited<ReturnType<ModelRouter['inference']>>;

export type SubagentTelemetryToolCall = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  resultSummary?: string;
  success: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
  index: number;
  parallel?: boolean;
  metadata?: Record<string, unknown>;
};

type SubagentTelemetryToolDef = {
  name: string;
  inputSchema: unknown;
  requiresPermission?: boolean;
  permissionLevel?: string;
};

/**
 * 构造单轮推理的 TelemetryModelCall（纯函数）。usage 缺省时按文本估算 token。
 */
export function buildSubagentModelCall(params: {
  response: ModelInferenceResponse;
  providerMessages: ProviderModelMessage[];
  modelConfig: ModelConfig;
  inferenceDuration: number;
  telemetryTurnId: string;
  turnNumber: number;
}): TelemetryModelCall {
  const { response, providerMessages, modelConfig, inferenceDuration, telemetryTurnId, turnNumber } = params;
  const responseTextForTokens = [
    response.content,
    response.thinking,
    response.toolCalls?.map((toolCall) => JSON.stringify(toolCall.arguments || {})).join(''),
  ].filter(Boolean).join('\n');
  return {
    id: `mc-${telemetryTurnId}-${turnNumber}`,
    timestamp: Date.now(),
    provider: modelConfig.provider,
    model: modelConfig.model,
    temperature: modelConfig.temperature,
    maxTokens: modelConfig.maxTokens,
    inputTokens: response.usage?.inputTokens ?? estimateTokens(
      providerMessages.map((message) => stringifyModelContent(message.content)).join('\n'),
    ),
    outputTokens: response.usage?.outputTokens ?? estimateTokens(responseTextForTokens),
    latencyMs: inferenceDuration,
    responseType: response.type,
    toolCallCount: response.toolCalls?.length ?? 0,
    truncated: !!response.truncated,
    prompt: buildModelPromptSummary(providerMessages),
    completion: buildModelCompletionSummary(response),
  };
}

/**
 * 记录一次 detached turn（telemetry 副作用经 collector）。userPrompt 首轮取原始 prompt，
 * 其后取迭代占位。events 携带本轮可用的工具 schema 快照。
 */
export function recordSubagentTelemetryTurn(
  collector: TelemetryCollector,
  params: {
    sessionId: string;
    turnId: string;
    turnNumber: number;
    prompt: string;
    assistantResponse: string;
    thinking?: string;
    agentId: string;
    parentTurnId?: string;
    startTime: number;
    modelCall: TelemetryModelCall;
    toolCalls: SubagentTelemetryToolCall[];
    toolDefinitions: SubagentTelemetryToolDef[];
  },
): void {
  const {
    sessionId, turnId, turnNumber, prompt, assistantResponse, thinking,
    agentId, parentTurnId, startTime, modelCall, toolCalls, toolDefinitions,
  } = params;
  collector.recordDetachedTurn({
    sessionId,
    turnId,
    turnNumber,
    userPrompt: turnNumber === 1 ? prompt : `Subagent iteration ${turnNumber}`,
    assistantResponse,
    thinking,
    agentId,
    parentTurnId,
    startTime,
    endTime: Date.now(),
    modelCalls: [modelCall],
    toolCalls,
    events: [{
      eventType: 'tool_schema_snapshot',
      summary: `${toolDefinitions.length} tool schemas available`,
      data: {
        tools: toolDefinitions.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          requiresPermission: tool.requiresPermission,
          permissionLevel: tool.permissionLevel,
        })),
      },
      timestamp: startTime,
    }],
  });
}

/**
 * 排空结构化消息队列并注入会话（mid-loop injection）。按引用 push 到 messages，
 * 返回注入条数（>0 时调用方负责发快照）。shutdown_request 仅记录并停止本轮排空。
 */
export function drainSubagentMessages(params: {
  agentName: string;
  messages: RuntimeMessage[];
  pendingMessages: AgentMessage[];
  logger: { info: (msg: string) => void };
  pushObservabilityMessage: (message: unknown) => void;
}): number {
  const { agentName, messages, pendingMessages, logger, pushObservabilityMessage } = params;
  if (pendingMessages.length === 0) {
    return 0;
  }
  for (const msg of pendingMessages) {
    if (msg.type === 'shutdown_request') {
      // Graceful shutdown: break after current iteration
      logger.info(`[${agentName}] Received shutdown_request from ${msg.from}`);
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
  logger.info(`[${agentName}] Processed ${pendingMessages.length} queued messages`);
  return pendingMessages.length;
}
