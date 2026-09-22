// ============================================================================
// Subagent Executor Telemetry Helpers
// ============================================================================
// 从 SubagentExecutor 抽出的纯遥测构造逻辑：每轮 modelCall 构造、detached turn 记录、
// 中途队列消息注入。均为纯函数（输入→输出 / 经回调产生副作用），不依赖实例状态。

import type { ModelConfig } from '../../shared/contract';
import type { AgentMessage, AgentMessageOrigin } from './messageOrigin';
import { resolveMessageOrigin } from './messageOrigin';
import type { ModelMessage as ProviderModelMessage } from '../model/types';
import type { ModelRouter } from '../model/modelRouter';
import type { TelemetryModelCall } from '../../shared/contract/telemetry';
import type { TelemetryCollector } from '../telemetry/telemetryCollector';
import { estimateTokens } from '../context/tokenEstimator';
import { generateMessageId } from '../../shared/utils/id';
import { getInputSanitizer, type SanitizationWarning } from '../security/inputSanitizer';
import {
  buildSecurityWarningMessage,
  generateBoundaryNonce,
  wrapUntrustedContentBoundary,
} from '../security/untrustedContentBoundary';
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
 * 文本消息的注入前缀按宿主铸造的 origin 生成（ADR-067 D1），不再按 from 二分
 * 冒充 parent/user；存量无 origin 的消息从严按 peer-agent 渲染。
 */
function injectedTextPrefix(msg: AgentMessage): string {
  const origin = resolveMessageOrigin(msg.origin);
  switch (origin.senderKind) {
    case 'user':
      return 'User message';
    case 'orchestrator':
      return 'Orchestrator';
    case 'dependency':
      return 'Dependency message';
    case 'peer-agent':
      // senderAgentId 只取宿主铸造的 origin；不可信的 from 展示串一律不进前缀
      // （无 origin 的伪造 from='user' 不许渲染成 "[Peer agent user]:"）。
      return origin.senderAgentId ? `Peer agent ${origin.senderAgentId}` : 'Peer agent';
  }
}

type DrainLogger = {
  info: (msg: string) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
};

type GuardedQueuedPayload =
  | { kind: 'inject'; content: string }
  | { kind: 'blocked'; source: string; warnings: SanitizationWarning[] };

/**
 * ADR-067 D2 push 路防线：队列注入的 peer/orchestrator/dependency 消息进 user-role
 * 上下文前，过与 pull 路（toolResultLifecycle.ts 对 multiagent 工具结果）同口径的
 * InputSanitizer 扫描 + nonce 边界包裹——同一个 sanitizer 单例、同一个 scope:'lenient'、
 * 同一套 block/annotate 阈值，不另造策略。user 本人消息不包（ADR 明确不做）。
 * 存量无 origin 的消息经 resolveMessageOrigin 从严视同 peer-agent，同样过防线。
 * block 档丢该条（返回 blocked，调用方负责观测留痕）；annotate 档包边界并附安全警告。
 */
function guardQueuedMessagePayload(params: {
  origin: AgentMessageOrigin;
  payload: string;
  logger: DrainLogger;
}): GuardedQueuedPayload {
  const { origin, payload, logger } = params;
  if (origin.senderKind === 'user') {
    return { kind: 'inject', content: payload };
  }
  const source = `queued-${origin.senderKind}-message`;
  try {
    const sanitized = getInputSanitizer().sanitize(payload, source, { scope: 'lenient' });
    if (sanitized.blocked) {
      logger.warn?.('Queued message blocked by InputSanitizer', {
        source,
        senderKind: origin.senderKind,
        riskScore: sanitized.riskScore,
        warnings: sanitized.warnings.length,
      });
      return { kind: 'blocked', source, warnings: sanitized.warnings };
    }
    const nonce = sanitized.nonce || generateBoundaryNonce();
    const wrapped = wrapUntrustedContentBoundary({ nonce, source, content: sanitized.sanitized });
    if (sanitized.warnings.length > 0) {
      return {
        kind: 'inject',
        content: buildSecurityWarningMessage({
          nonce,
          source,
          isSubagentResult: true,
          warnings: sanitized.warnings,
          riskScore: sanitized.riskScore,
        }) + '\n' + wrapped,
      };
    }
    return { kind: 'inject', content: wrapped };
  } catch (error) {
    // 与 pull 路一致：扫描器自身故障 fail-open 不丢消息，但机器边界仍要包上
    logger.warn?.('InputSanitizer error on queued message', { source, error: String(error) });
    return {
      kind: 'inject',
      content: wrapUntrustedContentBoundary({ nonce: generateBoundaryNonce(), source, content: payload }),
    };
  }
}

/**
 * 排空结构化消息队列并注入会话（mid-loop injection）。按引用 push 到 messages，
 * 返回注入条数（>0 时调用方负责发快照）。shutdown_request 仅记录并停止本轮排空。
 * 被安全扫描拦截的消息不进上下文，只在观测通道留 BLOCKED 痕迹，不计入返回条数。
 */
export function drainSubagentMessages(params: {
  agentName: string;
  messages: RuntimeMessage[];
  pendingMessages: AgentMessage[];
  logger: DrainLogger;
  pushObservabilityMessage: (message: unknown) => void;
}): number {
  const { agentName, messages, pendingMessages, logger, pushObservabilityMessage } = params;
  if (pendingMessages.length === 0) {
    return 0;
  }
  let injectedCount = 0;
  let blockedCount = 0;
  for (const msg of pendingMessages) {
    if (msg.type === 'shutdown_request') {
      // Graceful shutdown: break after current iteration
      logger.info(`[${agentName}] Received shutdown_request from ${msg.from}`);
      break;
    }
    // Text and other message types: inject into conversation
    // 前缀只认 origin（ADR-067）：user/orchestrator/peer 各自诚实标注，不再冒充
    const prefix = msg.type === 'text'
      ? injectedTextPrefix(msg)
      : `Agent message (${msg.type})`;
    const guarded = guardQueuedMessagePayload({
      origin: resolveMessageOrigin(msg.origin),
      payload: msg.payload,
      logger,
    });
    if (guarded.kind === 'blocked') {
      blockedCount += 1;
      // 与 pull 路同一 BLOCKED 文案口径：payload 不进上下文，观测通道留痕
      pushObservabilityMessage({
        id: generateMessageId(),
        role: 'user',
        content: `[${prefix}]: [BLOCKED] Content from ${guarded.source} was blocked due to security concerns: ${guarded.warnings.map((warning) => warning.description).join('; ')}`,
        timestamp: Date.now(),
      });
      continue;
    }
    const content = `[${prefix}]: ${guarded.content}`;
    messages.push(createRuntimeMessage({
      role: 'user',
      content,
      observation: buildObservation('dependency_carry_over', msg.from, {
        sourceKind: 'dependency_carry_over',
        layer: 'carry_over',
      }),
    }));
    injectedCount += 1;
    pushObservabilityMessage({
      id: generateMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    });
  }
  logger.info(
    `[${agentName}] Processed ${pendingMessages.length} queued messages` +
    (blockedCount > 0 ? ` (${blockedCount} blocked by security scan)` : ''),
  );
  return injectedCount;
}
