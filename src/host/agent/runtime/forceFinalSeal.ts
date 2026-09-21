// ============================================================================
// forceFinalSeal — 强制收尾（forceFinalResponse）生效后的工具通道封口
//
// 背景（issue #1991 夜跑 2026-09-20）：只读循环撞硬阈值 → forceFinalResponse 置位
// 后，模型（尤其 LongCat 这类工具表被清空就回落到裸 <longcat_tool_call> 文本协议
// 的模型）仍继续发工具调用。旧实现把这些调用照常派发到 executor 再逐条拦下，
// 每条都以 success=false 落 onToolCallEnd —— 单会话 136 次"工具失败"全是抑制性
// 拦截，遥测全脏；裸标记还漏进最终回复怼到用户脸上。
//
// 本模块提供两层封口：
//   1) emitForceFinalSkippedToolResult —— 批内（forceFinal 在执行中途置位）剩余
//      调用的抑制结果：照发 UI 事件让卡片收口，但不写任何遥测（不计工具失败）。
//   2) sealToolCallsDuringForceFinal —— 整轮封口：forceFinal 已置位时模型又回了
//      tool_use，完全不派发 executor，合成 skipped 结果落账后直接走强制收尾结论。
// ============================================================================

import { HostReasonCode, type Message, type ToolCall, type ToolResult } from '../../../shared/contract';
import type { ModelResponse } from '../loopTypes';
import { sanitizeToolCallsForHistory } from '../messageHandling/converter';
import { createLogger } from '../../services/infra/logger';
import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { emitArtifactRepairStopError } from './artifactRepairStopError';
import { emitGoalAbort } from './goalAbort';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import { MAX_STEPS_REASON } from './maxStepsFallback';
import {
  buildForcedFinalAssistantContent,
  sanitizeToolArgumentsForObservation,
  sanitizeToolResultForObservation,
  shouldDeferForcedFinalToInference,
} from './messageProcessorHelpers';
import { getToolAttemptTrace } from './toolAttemptTrace';
import { attachTurnQualityMetadata } from './turnQuality';

const logger = createLogger('ForceFinalSeal');

type LangfuseSpanFacade = {
  endSpan(spanId: string, output?: unknown, level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR', statusMessage?: string): void;
};

export interface ForceFinalSealDeps {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
}

function buildForceFinalSkippedToolResult(
  ctx: RuntimeContext,
  toolCall: ToolCall,
  duration = 0,
): ToolResult {
  return {
    toolCallId: toolCall.id,
    success: false,
    error: `Tool skipped because final response is already forced: ${ctx.control.forceFinalResponseReason}`,
    duration,
    metadata: {
      skipped: true,
      blocked: true,
      forceFinalSuppressed: true,
      forceFinalResponseReason: ctx.control.forceFinalResponseReason,
    },
  };
}

/**
 * 批内抑制：只发 UI 事件（tool_call_start/end）让前端卡片正常收口，
 * 刻意不碰 telemetryAdapter —— 被强制收尾吞掉的调用不是工具失败。
 */
export function emitForceFinalSkippedToolResult(
  ctx: RuntimeContext,
  toolCall: ToolCall,
  index: number,
  duration = 0,
): ToolResult {
  const toolResult = buildForceFinalSkippedToolResult(ctx, toolCall, duration);
  ctx.onEvent({
    type: 'tool_call_start',
    data: {
      ...toolCall,
      arguments: sanitizeToolArgumentsForObservation(toolCall) ?? {},
      _index: index,
      turnId: ctx.turn.currentTurnId,
    },
  });
  ctx.onEvent({
    type: 'tool_call_end',
    data: sanitizeToolResultForObservation(toolCall, toolResult),
  });
  return toolResult;
}

/**
 * 强制收尾结论（从 MessageProcessor.handleToolResponse 尾部抽出，两处共用）：
 * 只读硬阈值类原因 → 'continue' 让 inference 层做一次禁工具的最终推理；
 * 其余原因 → 就地落最终 assistant 消息并 'break' 结束本轮。
 */
export async function concludeForceFinalAfterToolBatch(
  deps: ForceFinalSealDeps,
  response: ModelResponse,
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
  langfuse: LangfuseSpanFacade,
): Promise<'continue' | 'break'> {
  const { ctx, contextAssembly } = deps;
  const reason = ctx.control.forceFinalResponseReason ?? '';

  if (shouldDeferForcedFinalToInference(ctx)) {
    logger.warn('[AgentLoop] Read-loop hard limit reached; deferring final answer to no-tool inference', { reason });
    contextAssembly.flushHookMessageBuffer();
    langfuse.endSpan(ctx.turn.currentIterationSpanId, {
      type: 'tool_calls',
      toolCount: toolCalls.length,
      successCount: toolResults.filter((r) => r.success).length,
      forcedFinalResponseDeferred: true,
    });
    // Close this tool turn before the deferred no-tool inference starts a fresh turn.
    ctx.telemetryAdapter?.onTurnEnd(ctx.turn.currentTurnId, '', response.thinking, ctx.contextHealth.currentSystemPromptHash);
    ctx.onEvent({ type: 'turn_end', data: { turnId: ctx.turn.currentTurnId } });
    return 'continue';
  }

  const finalMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: buildForcedFinalAssistantContent(reason),
    timestamp: Date.now(),
    effortLevel: ctx.turn.effortLevel,
    metadata: attachTurnQualityMetadata(ctx, undefined, response),
  };
  await contextAssembly.addAndPersistMessage(finalMessage);
  ctx.onEvent({ type: 'message', data: finalMessage });

  // admission_stop:在 final assistant message push 后 emit error,
  // useSessionLifecycleEffects 会把 errorContent 合并到 lastMessage(此时 = finalMessage assistant)上显示。
  emitArtifactRepairStopError(ctx, reason);

  ctx.control.clearForceFinalResponse();
  contextAssembly.flushHookMessageBuffer();
  langfuse.endSpan(ctx.turn.currentIterationSpanId, {
    type: 'tool_calls',
    toolCount: toolCalls.length,
    successCount: toolResults.filter((r) => r.success).length,
    forcedFinalResponse: true,
  });
  ctx.telemetryAdapter?.onTurnEnd(ctx.turn.currentTurnId, '', response.thinking, ctx.contextHealth.currentSystemPromptHash);
  ctx.onEvent({ type: 'turn_end', data: { turnId: ctx.turn.currentTurnId } });
  return 'break';
}

/**
 * 整轮封口：forceFinalResponse 已置位时模型仍回了 tool_use（典型：禁工具推理轮
 * 模型回落到裸工具调用协议，或 provider 无视空工具表）。一律不派发 executor、
 * 不写遥测，合成 skipped 结果落账（turnTrace 留痕 outcome=skipped），然后直接
 * 进入强制收尾结论。
 */
export async function sealToolCallsDuringForceFinal(
  deps: ForceFinalSealDeps,
  response: ModelResponse,
  toolCalls: ToolCall[],
  langfuse: LangfuseSpanFacade,
): Promise<'continue' | 'break'> {
  const { ctx, contextAssembly } = deps;
  logger.warn('[AgentLoop] Tool calls arrived while final response is forced; sealing without dispatch', {
    reason: ctx.control.forceFinalResponseReason,
    toolCount: toolCalls.length,
    tools: toolCalls.map((call) => call.name).join(', '),
  });

  const assistantMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: contextAssembly.stripInternalFormatMimicry(response.content || ''),
    timestamp: Date.now(),
    toolCalls: sanitizeToolCallsForHistory(toolCalls),
    thinking: response.thinking,
    effortLevel: ctx.turn.effortLevel,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    metadata: attachTurnQualityMetadata(ctx, undefined, response),
  };
  await contextAssembly.addAndPersistMessage(assistantMessage);
  ctx.onEvent({ type: 'message', data: assistantMessage });

  const suppressedResults = toolCalls.map((toolCall, index) => {
    getToolAttemptTrace(ctx).begin(toolCall);
    // 与批内抑制同一事件形状：start + end 都发（前端按 tool_call_start 建卡），
    // 只发 end 会留下永远 running 的孤儿卡片（ai-review PR#2006 Nit）。
    const result = emitForceFinalSkippedToolResult(ctx, toolCall, index);
    getToolAttemptTrace(ctx).finish(toolCall, result, false, 0);
    return result;
  });
  const toolMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'tool',
    content: JSON.stringify(suppressedResults),
    timestamp: Date.now(),
    toolResults: suppressedResults,
  };
  await contextAssembly.addAndPersistMessage(toolMessage);
  ctx.onEvent({ type: 'message', data: toolMessage });

  return concludeForceFinalAfterToolBatch(deps, response, toolCalls, suppressedResults, langfuse);
}

/**
 * 强制收尾文本轮 break 时 goal 仍 pending 的收口（ai-review PR#2006 Important 1）：
 * goal 契约拒绝无痕退出——静默 break 会让 run 看似 completed、goal 永远 pending、
 * UI 目标状态收不了口。这里发 goal_complete(aborted) 把终态坐实；
 * 返回是否真发了中止（goal 非 pending 时 false，调用方据此不改 terminal）。
 * 中止码按收尾原因映射（ai-review 轮 2 Important）：预算/步数耗尽报 RepeatedAction
 * 会把「该加预算」误导成「改目标」。
 */
export function abortPendingGoalOnForcedFinalBreak(ctx: RuntimeContext, turns: number): boolean {
  const reason = ctx.control.forceFinalResponseReason ?? 'forced final';
  const code = reason === 'resource-limit-reached'
    ? HostReasonCode.GoalAbortTokenBudget
    : reason === MAX_STEPS_REASON
      ? HostReasonCode.GoalAbortTurnLimit
      : HostReasonCode.GoalAbortRepeatedAction;
  return emitGoalAbort(ctx, {
    code,
    modelText: `强制收尾（${reason}）触发时目标仍未达成`,
    turns,
    tokensUsed: goalTokensUsedWithSwarm(ctx),
  });
}
