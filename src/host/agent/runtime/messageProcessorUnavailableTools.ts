// ============================================================================
// handleUnavailableToolCalls — 处理「模型本轮请求了当前不可见/未解锁的工具」。
//
// 从 MessageProcessor.handleToolResponse 抽出（降 messageProcessor 行数 + 单一职责）。
// 两条子路径：
//   1) Graceful deferred-tool 自愈：非真实 artifact 修复期时，自动解锁被模型直接调用的
//      deferred 工具（Task/AgentSpawn/...），回灌「已加载，请重新调用」让其下一轮带 schema 重试。
//   2) Artifact 修复期收窄：注入 admission-repair 提示 + 合成失败结果；触达死循环逃生门时
//      走 forceFinal 收尾（'break'）。
//
// 依赖通过 deps 注入，避免与 MessageProcessor 强耦合。
// ============================================================================

import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import type { ModelResponse } from '../../agent/loopTypes';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import {
  sanitizeToolCallsForHistory,
  sanitizeToolResultsForHistoryWithCalls,
} from '../../agent/messageHandling/converter';
import { getToolSearchService } from '../../services/toolSearch/toolSearchService';
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import { getArtifactRepairToolPolicy } from './artifactRepairGuard';
import { activateArtifactRepairAdmissionStop } from './artifactRepairAdmission';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../shared/constants/repair';
import {
  buildArtifactRepairAdmissionRecoveryPrompt,
  buildForcedFinalAssistantContent,
  sanitizeToolResultForObservation,
} from './messageProcessorHelpers';
import { attachTurnQualityMetadata } from './turnQuality';
import { buildStrictToolsetNotice } from '../../tools/skillBoundaryScope';

export interface UnavailableToolCallsDeps {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  /** 转发 MessageProcessor.maybeEmitArtifactRepairStopError（forceFinal 收尾时发错误事件）。 */
  emitArtifactRepairStopError: (reason: string) => void;
}

/**
 * 调用前提：unavailableToolCalls.length > 0。每条路径都返回 'continue' | 'break'。
 */
export async function handleUnavailableToolCalls(
  deps: UnavailableToolCallsDeps,
  response: ModelResponse,
  toolCalls: ToolCall[],
  unavailableToolCalls: ToolCall[],
  visibleToolNames: Set<string>,
): Promise<'continue' | 'break'> {
  const { ctx, contextAssembly, emitArtifactRepairStopError } = deps;

  // ── Graceful deferred-tool 自愈 ─────────────────────────────────
  // 模型直接调用了尚未通过 ToolSearch 解锁的 deferred 工具（典型：Task / AgentSpawn /
  // wait_agent 等多 agent 工具）。这并非 artifact 修复期的工具收窄——若当前不在真实
  // artifact 修复（无 targetFile），就自动解锁这些工具：下一轮即可携带完整 schema 正常
  // 调用，而不是用误导性的 "not available in the current repair step" 把模型劝退。
  // 这是"多 agent 跑不通"的根因（deferred 多 agent 工具被通用拦截误伤）。
  const isRealArtifactRepair = !!ctx.artifact.repairGuard?.targetFile;
  if (!isRealArtifactRepair) {
    const toolSearchService = getToolSearchService();
    const autoLoaded: string[] = [];
    for (const call of unavailableToolCalls) {
      const canonical = resolveToolAlias(call.name);
      const selection = toolSearchService.selectTool(canonical);
      if (selection.loadedTools.length > 0) {
        autoLoaded.push(...selection.loadedTools);
      }
    }
    if (autoLoaded.length > 0) {
      const loadedList = Array.from(new Set(autoLoaded)).join(', ');
      contextAssembly.injectSystemMessage(
        [
          '<tool-auto-loaded>',
          `These tools are now loaded and available: ${loadedList}.`,
          'They were progressive-disclosure tools that had not been loaded yet. Call them again now with the correct arguments — do not say you lack them.',
          '</tool-auto-loaded>',
        ].join('\n'),
      );
      const assistantMsg: Message = {
        id: contextAssembly.generateId(),
        role: 'assistant',
        content: response.content || '',
        timestamp: Date.now(),
        toolCalls: sanitizeToolCallsForHistory(toolCalls),
        thinking: response.thinking,
        effortLevel: ctx.turn.effortLevel,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        metadata: attachTurnQualityMetadata(ctx, undefined, response),
      };
      await contextAssembly.addAndPersistMessage(assistantMsg);
      ctx.onEvent({ type: 'message', data: assistantMsg });

      const recoveryResults: ToolResult[] = toolCalls.map((toolCall) => {
        const wasUnavailable = unavailableToolCalls.some((c) => c.id === toolCall.id);
        return {
          toolCallId: toolCall.id,
          success: false,
          error: wasUnavailable
            ? `Tool ${toolCall.name} was not loaded yet and has now been auto-loaded. Call it again with the correct arguments.`
            : 'Skipped because the same model response included not-yet-loaded tools.',
          duration: 0,
          // autoLoaded 标记：这是"工具自动加载→让模型重试"的良性内部状态，不是真失败。
          // UI 据此不把它计入失败/不弹「暂停恢复」错误 chip/不让工具组状态卡在 error。
          metadata: { autoLoadedTools: loadedList, autoLoaded: true },
        };
      });
      const toolMsg: Message = {
        id: contextAssembly.generateId(),
        role: 'tool',
        content: JSON.stringify(recoveryResults),
        timestamp: Date.now(),
        toolResults: recoveryResults,
      };
      await contextAssembly.addAndPersistMessage(toolMsg);
      ctx.onEvent({ type: 'message', data: toolMsg });
      const sanitizedRecovery = sanitizeToolResultsForHistoryWithCalls(recoveryResults, toolCalls);
      sanitizedRecovery.forEach((result) => {
        ctx.onEvent({
          type: 'tool_call_end',
          data: sanitizeToolResultForObservation(
            toolCalls.find((toolCall) => toolCall.id === result.toolCallId),
            result,
          ),
        });
      });
      return 'continue';
    }
  }

  const requestedNames = unavailableToolCalls.map((toolCall) => toolCall.name).join(', ');
  const allowedNames = [...visibleToolNames].join(', ') || 'none';
  const guard = ctx.artifact.repairGuard;
  const noProgressTurns = guard ? ctx.artifact.recordNoProgressTurn(requestedNames) : 0;
  const repairPolicy = getArtifactRepairToolPolicy(guard);
  // Route A 死循环逃生门：连续 ARTIFACT_REPAIR_MAX_ATTEMPTS 次无进展动作（反复请求
  // 不可用工具 / 被 repair 闸拦）且没有任何成功的目标文件改动，强制收尾，避免无限重试。
  if (guard?.targetFile && noProgressTurns >= ARTIFACT_REPAIR_MAX_ATTEMPTS) {
    activateArtifactRepairAdmissionStop(ctx, guard.targetFile, requestedNames);
  }
  const recoveryPrompt = guard?.targetFile
    ? buildArtifactRepairAdmissionRecoveryPrompt(
        guard.targetFile,
        requestedNames,
        allowedNames,
        repairPolicy,
      )
    : null;
  // strict skill 边界收窄时把原因和出路一并给模型，避免它对用户编"环境受限"
  const strictBoundary = ctx.turn.skillToolBoundary?.strict ? ctx.turn.skillToolBoundary : undefined;
  contextAssembly.injectSystemMessage(
    [
      '<tool-admission-repair>',
      `The previous tool call requested unavailable tools: ${requestedNames}.`,
      `Only these tools are currently available: ${allowedNames}.`,
      strictBoundary
        ? `Reason: the "${strictBoundary.skillName}" strict skill flow is active, which narrows the visible toolset by design. ${buildStrictToolsetNotice(strictBoundary)}`
        : '',
      'Do not repeat the unavailable tool call. Pick the next action only from the currently available tools.',
      recoveryPrompt || '',
      '</tool-admission-repair>',
    ].filter(Boolean).join('\n'),
  );
  if (recoveryPrompt) {
    contextAssembly.pushPersistentSystemContext(recoveryPrompt);
  }
  const assistantMsg: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: response.content || '',
    timestamp: Date.now(),
    toolCalls: sanitizeToolCallsForHistory(toolCalls),
    thinking: response.thinking,
    effortLevel: ctx.turn.effortLevel,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    metadata: attachTurnQualityMetadata(ctx, undefined, response),
  };
  await contextAssembly.addAndPersistMessage(assistantMsg);
  ctx.onEvent({ type: 'message', data: assistantMsg });

  const syntheticResults: ToolResult[] = toolCalls.map((toolCall) => {
    const blocked = unavailableToolCalls.some((blockedCall) => blockedCall.id === toolCall.id);
    return {
      toolCallId: toolCall.id,
      success: false,
      error: blocked
        ? [
          `Tool ${toolCall.name} is not available in the current repair step.`,
          `Available tools: ${allowedNames}.`,
          recoveryPrompt || 'Use the currently visible tools only.',
        ].join('\n')
        : 'Skipped because the same model response included unavailable repair tools.',
      duration: 0,
      metadata: {
        // telemetry 与 UI 可据此判断失败源头是流程性收窄而非工具真坏
        narrowedBy: guard?.targetFile ? 'artifact_repair' : strictBoundary ? 'strict_skill' : 'unavailable',
        artifactRepairGuard: {
          blocked: true,
          unavailableTool: blocked,
          targetFile: guard?.targetFile,
          phase: guard?.phase,
          attempts: guard?.attempts,
          noProgressTurns: guard?.noProgressTurns,
          lastBlockedTool: requestedNames,
        },
      },
    };
  });
  const toolMsg: Message = {
    id: contextAssembly.generateId(),
    role: 'tool',
    content: JSON.stringify(syntheticResults),
    timestamp: Date.now(),
    toolResults: syntheticResults,
  };
  await contextAssembly.addAndPersistMessage(toolMsg);
  const sanitizedResults = sanitizeToolResultsForHistoryWithCalls(syntheticResults, toolCalls);
  ctx.onEvent({ type: 'message', data: toolMsg });
  sanitizedResults.forEach((result) => {
    ctx.onEvent({
      type: 'tool_call_end',
      data: sanitizeToolResultForObservation(
        toolCalls.find((toolCall) => toolCall.id === result.toolCallId),
        result,
      ),
    });
  });

  // admission_stop 触发分支:不能 'continue' 让模型再试一轮,否则模型继续请求 unavailable tool
  // 永远绕过 forceFinalResponse handler(在正常 tool 路径之后),turn 永远不结束。
  // 这里 inline 走完 forceFinal 流程: push final assistant message + emit error + turn_end + 'break'。
  if (ctx.control.forceFinalResponseReason) {
    const finalMessage: Message = {
      id: contextAssembly.generateId(),
      role: 'assistant',
      content: buildForcedFinalAssistantContent(ctx.control.forceFinalResponseReason),
      timestamp: Date.now(),
      effortLevel: ctx.turn.effortLevel,
      metadata: attachTurnQualityMetadata(ctx, undefined, response),
    };
    await contextAssembly.addAndPersistMessage(finalMessage);
    ctx.onEvent({ type: 'message', data: finalMessage });

    emitArtifactRepairStopError(ctx.control.forceFinalResponseReason);

    ctx.control.clearForceFinalResponse();
    ctx.telemetryAdapter?.onTurnEnd(ctx.turn.currentTurnId, '', undefined, ctx.contextHealth.currentSystemPromptHash);
    ctx.onEvent({ type: 'turn_end', data: { turnId: ctx.turn.currentTurnId } });
    return 'break';
  }
  return 'continue';
}
