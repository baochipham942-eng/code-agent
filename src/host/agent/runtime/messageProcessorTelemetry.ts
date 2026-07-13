import type { Message, ToolCall } from '../../../shared/contract';
import { estimateModelMessageTokens } from '../../context/tokenOptimizer';
import type { ModelResponse } from '../../agent/loopTypes';
import type { RuntimeContext } from './runtimeContext';

function serializeMessageContent(message: Message): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

export function recordMessageProcessorModelCallTelemetry(
  ctx: RuntimeContext,
  response: ModelResponse,
  iterations: number,
  inferenceDuration: number,
): void {
  if (!ctx.telemetryAdapter) return;

  const maxPromptLength = 8000;
  const maxCompletionLength = 4000;

  const promptSummary = ctx.messages
    .slice(-3)
    .map((message: Message) => `[${message.role}] ${serializeMessageContent(message)}`)
    .join('\n---\n');

  let completionText = '';
  if (response.content) {
    completionText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  }
  if (response.toolCalls?.length) {
    const toolsSummary = response.toolCalls
      .map((toolCall: ToolCall) => `${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 200)})`)
      .join('; ');
    completionText += (completionText ? '\n' : '') + `[tools: ${toolsSummary}]`;
  }

  const apiInputTokens = response.usage?.inputTokens ?? 0;
  const apiOutputTokens = response.usage?.outputTokens ?? 0;
  let effectiveInputTokens = apiInputTokens;
  let effectiveOutputTokens = apiOutputTokens;
  if (apiInputTokens === 0 || apiOutputTokens === 0) {
    const estimatedInputTokens = estimateModelMessageTokens(
      ctx.messages.slice(-10).map((message: Message) => ({ role: message.role, content: message.content })),
    );
    const outputContent = (response.content || '') +
      (response.toolCalls?.map((toolCall: ToolCall) => JSON.stringify(toolCall.arguments || {})).join('') || '');
    const estimatedOutputTokens = estimateModelMessageTokens([{ role: 'assistant', content: outputContent }]);
    if (apiInputTokens === 0) effectiveInputTokens = estimatedInputTokens;
    if (apiOutputTokens === 0) effectiveOutputTokens = estimatedOutputTokens;
  }

  ctx.telemetryAdapter.onModelCall(ctx.turn.currentTurnId, {
    id: `mc-${ctx.turn.currentTurnId}-${iterations}`,
    timestamp: Date.now(),
    provider: response.actualProvider ?? response.fallback?.to.provider ?? ctx.modelConfig.provider,
    model: response.actualModel ?? response.fallback?.to.model ?? ctx.modelConfig.model,
    temperature: ctx.modelConfig.temperature,
    maxTokens: ctx.modelConfig.maxTokens,
    inputTokens: effectiveInputTokens,
    outputTokens: effectiveOutputTokens,
    latencyMs: inferenceDuration,
    responseType: response.type as 'text' | 'tool_use' | 'thinking',
    toolCallCount: response.toolCalls?.length ?? 0,
    truncated: !!response.truncated,
    requestProtocol: 'agent-loop',
    retryCount: Math.max(0, iterations - 1),
    resultStatus: 'success',
    traceSpanId: ctx.lastModelTraceSpanId,
    prompt: promptSummary.substring(0, maxPromptLength),
    completion: completionText.substring(0, maxCompletionLength),
  });
}
