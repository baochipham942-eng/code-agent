// ============================================================================
// Telemetry turn upload row — 上传器与 `neo telemetry preview` 共用的唯一字段表
// ============================================================================
//
// metadata-only：不抄 prompt / completion / userPrompt / assistantResponse /
// 工具入参或返回内容。每一个会离开本机的字符串都过 scrubString。

import type { TelemetryTurn } from '../../shared/contract/telemetry';
import { scrubString } from '../../shared/observability/scrubEvent';

export const TELEMETRY_PREVIEW_SESSION_ID = 'preview-session';
export const TELEMETRY_PREVIEW_USER_ID = 'preview-user';

const PREVIEW_PLANTED_PROMPT = 'NEO_PREVIEW_PLANTED_PROMPT';
const PREVIEW_PLANTED_TOOL = 'NEO_PREVIEW_PLANTED_TOOL_CONTENT';

function scrub(value: string, homeDir: string): string {
  return scrubString(value, { homeDir });
}

export function buildTelemetryTurnUploadRow(
  turn: TelemetryTurn,
  sessionId: string,
  userId: string,
  homeDir: string,
) {
  const payload = {
    modelCalls: turn.modelCalls.map((call) => ({
      provider: scrub(call.provider, homeDir),
      model: scrub(call.model, homeDir),
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      responseType: scrub(call.responseType, homeDir),
      fallbackUsed: call.fallbackUsed
        ? {
          from: scrub(call.fallbackUsed.from, homeDir),
          to: scrub(call.fallbackUsed.to, homeDir),
          reason: scrub(call.fallbackUsed.reason, homeDir),
        }
        : undefined,
      error: call.error ? scrub(call.error, homeDir) : undefined,
    })),
    toolCalls: turn.toolCalls.map((call) => ({
      name: scrub(call.name, homeDir),
      success: call.success,
      errorCategory: call.errorCategory ? scrub(call.errorCategory, homeDir) : undefined,
      durationMs: call.durationMs,
      error: call.error ? scrub(call.error, homeDir) : undefined,
    })),
  };
  return {
    id: scrub(turn.id, homeDir),
    session_id: scrub(sessionId, homeDir),
    user_id: scrub(userId, homeDir),
    turn_number: turn.turnNumber,
    turn_type: scrub(turn.turnType, homeDir),
    agent_id: turn.agentId == null ? null : scrub(turn.agentId, homeDir),
    intent: turn.intent?.primary == null ? null : scrub(turn.intent.primary, homeDir),
    outcome_status: turn.outcome?.status == null ? null : scrub(turn.outcome.status, homeDir),
    duration_ms: turn.durationMs,
    total_input_tokens: turn.totalInputTokens,
    total_output_tokens: turn.totalOutputTokens,
    tool_call_count: turn.toolCalls.length,
    error_count: turn.outcome?.signals?.errorCount ?? 0,
    payload,
  };
}

/** 内存里的合成样本。preview 只用它，不读用户数据库。 */
export function buildTelemetryPreviewTurn(homeDir: string): TelemetryTurn {
  const plantedPath = `${homeDir}/neo-preview-secret`;
  return {
    id: 'preview-turn',
    sessionId: TELEMETRY_PREVIEW_SESSION_ID,
    turnNumber: 1,
    startTime: 1,
    endTime: 2,
    durationMs: 1,
    userPrompt: PREVIEW_PLANTED_PROMPT,
    userPromptTokens: 3,
    hasAttachments: false,
    attachmentCount: 0,
    agentMode: 'default',
    effortLevel: 'low',
    modelCalls: [{
      id: 'preview-model',
      timestamp: 1,
      provider: 'preview',
      model: 'preview-model',
      inputTokens: 3,
      outputTokens: 1,
      latencyMs: 5,
      responseType: 'text',
      toolCallCount: 1,
      truncated: false,
      error: `model failed ${plantedPath}`,
      prompt: PREVIEW_PLANTED_PROMPT,
      completion: PREVIEW_PLANTED_PROMPT,
    }],
    toolCalls: [{
      id: 'preview-tool',
      toolCallId: 'preview-call',
      name: 'read_file',
      arguments: PREVIEW_PLANTED_TOOL,
      actualArguments: PREVIEW_PLANTED_TOOL,
      resultSummary: PREVIEW_PLANTED_TOOL,
      success: false,
      error: `tool failed ${plantedPath}`,
      errorCategory: 'unknown',
      durationMs: 2,
      timestamp: 1,
      index: 0,
      parallel: false,
    }],
    assistantResponse: PREVIEW_PLANTED_PROMPT,
    assistantResponseTokens: 1,
    totalInputTokens: 3,
    totalOutputTokens: 1,
    events: [],
    intent: { primary: 'unknown', confidence: 0, method: 'rule', keywords: [] },
    outcome: {
      status: 'failure',
      confidence: 1,
      method: 'rule',
      signals: {
        toolSuccessRate: 0,
        toolCallCount: 1,
        retryCount: 0,
        errorCount: 1,
        errorRecovered: 0,
        compactionTriggered: false,
        circuitBreakerTripped: false,
        nudgesInjected: 0,
      },
    },
    compactionOccurred: false,
    iterationCount: 1,
    turnType: 'user',
  };
}
