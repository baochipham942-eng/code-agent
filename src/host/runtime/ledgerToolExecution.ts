// ============================================================================
// 台账工具调用的「批准即执行一次」共享执行器
// ============================================================================
//
// 从 src/host/app/nativeRecoveryHost.ts 的 approval.dispatchPrepared / approval.reject
// 抽出的公共段（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME：停车审批重启批准复用，不复制）：
//   按 toolCallId 找台账里的 assistant 消息 → 结果已存在则跳过 → 执行 → 按
//   buildRecoveredToolMessage 的稳定 id 落 tool result 消息。
// 幂等锚点是消息 id `<assistantId>:<kind>-tool-result:<toolCallId>` 与
// toolResultEvidence 的存在性检查——同一条调用两次派发只落一条结果。
// ============================================================================

import type { Message, ToolResult } from '../../shared/contract';
import type { ToolExecutionResult } from '../tools/types';

export interface LedgerToolExecutionPorts {
  executeTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    sessionId: string;
    sourceMessageId: string;
    toolCallId: string;
    workingDirectory: string;
  }): Promise<ToolExecutionResult>;
  persistToolMessage(sessionId: string, message: Message): Promise<void>;
  now(): number;
}

export function toolResultEvidence(
  messages: Message[],
  toolCallId: string,
): { resultRef: string } | null {
  const message = messages.find((candidate) => (
    candidate.role === 'tool'
    && candidate.toolResults?.some((result) => result.toolCallId === toolCallId)
  ));
  return message ? { resultRef: `message-ledger:${message.id}` } : null;
}

export function persistedToolCall(messages: Message[], toolCallId: string) {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const toolCall = message.toolCalls?.find((candidate) => candidate.id === toolCallId);
    if (toolCall) return { assistantMessage: message, toolCall };
  }
  return null;
}

export function buildRecoveredToolMessage(input: {
  assistantMessage: Message;
  toolCallId: string;
  result: ToolResult;
  now: number;
  kind: 'replayed' | 'interrupted' | 'approved' | 'denied';
}): Message {
  return {
    id: `${input.assistantMessage.id}:${input.kind}-tool-result:${input.toolCallId}`,
    role: 'tool',
    content: JSON.stringify([input.result]),
    timestamp: input.now,
    toolResults: [input.result],
    ...(input.assistantMessage.isMeta ? { isMeta: true } : {}),
  };
}

export type LedgerToolApprovalDispatch =
  | { status: 'executed'; resultRef: string }
  | { status: 'already_present'; resultRef: string }
  | { status: 'payload_unavailable' };

/**
 * 批准后的台账单发：找台账调用 → 已有结果直接返回（不二次执行）→ 真执行 →
 * 落 approved 形结果消息。与 nativeRecoveryHost 的 approval.dispatchPrepared 同一语义。
 */
export async function dispatchLedgerToolApproval(
  ports: LedgerToolExecutionPorts,
  input: {
    messages: Message[];
    toolCallId: string;
    sessionId: string;
    sourceMessageId?: string;
    workingDirectory: string;
  },
): Promise<LedgerToolApprovalDispatch> {
  const persisted = persistedToolCall(input.messages, input.toolCallId);
  if (!persisted) return { status: 'payload_unavailable' };
  const existing = toolResultEvidence(input.messages, input.toolCallId);
  if (existing) return { status: 'already_present', resultRef: existing.resultRef };
  const result = await ports.executeTool({
    name: persisted.toolCall.name,
    arguments: persisted.toolCall.arguments,
    sessionId: input.sessionId,
    sourceMessageId: input.sourceMessageId ?? persisted.assistantMessage.id,
    toolCallId: persisted.toolCall.id,
    workingDirectory: input.workingDirectory,
  });
  const toolResult: ToolResult = {
    toolCallId: persisted.toolCall.id,
    success: result.success,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    duration: 0,
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
  const message = buildRecoveredToolMessage({
    assistantMessage: persisted.assistantMessage,
    toolCallId: persisted.toolCall.id,
    result: toolResult,
    now: ports.now(),
    kind: 'approved',
  });
  await ports.persistToolMessage(input.sessionId, message);
  return { status: 'executed', resultRef: `message-ledger:${message.id}` };
}

export type LedgerToolApprovalRejection =
  | { status: 'denied'; resultRef: string }
  | { status: 'already_present'; resultRef: string }
  | { status: 'payload_unavailable' };

/** 拒绝后的台账收口：给该 toolCallId 落一条 denied 结果消息（不执行任何东西）。 */
export async function rejectLedgerToolApproval(
  ports: LedgerToolExecutionPorts,
  input: {
    messages: Message[];
    toolCallId: string;
    sessionId: string;
    reason: string;
  },
): Promise<LedgerToolApprovalRejection> {
  const persisted = persistedToolCall(input.messages, input.toolCallId);
  if (!persisted) return { status: 'payload_unavailable' };
  const existing = toolResultEvidence(input.messages, input.toolCallId);
  if (existing) return { status: 'already_present', resultRef: existing.resultRef };
  const message = buildRecoveredToolMessage({
    assistantMessage: persisted.assistantMessage,
    toolCallId: persisted.toolCall.id,
    result: {
      toolCallId: persisted.toolCall.id,
      success: false,
      error: input.reason,
      duration: 0,
    },
    now: ports.now(),
    kind: 'denied',
  });
  await ports.persistToolMessage(input.sessionId, message);
  return { status: 'denied', resultRef: `message-ledger:${message.id}` };
}
