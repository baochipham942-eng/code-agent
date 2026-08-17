import type { Message, ToolCall } from '@shared/contract';
import type {
  PlanApprovalRecord,
  PlanApprovalResponse,
  PlanApprovalStep,
} from '@shared/contract/planApproval';

export interface PendingPlanApprovalTarget {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  approval: PlanApprovalRecord;
}

export function getPlanApprovalRecord(toolCall: ToolCall | undefined): PlanApprovalRecord | null {
  const value = toolCall?.result?.metadata?.planApproval;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as unknown as PlanApprovalRecord;
  if (!Array.isArray(record.steps) || typeof record.originalPlan !== 'string') return null;
  if (!['pending', 'approved', 'cancelled', 'revision_requested'].includes(record.status)) return null;
  return record;
}

export function findPendingPlanApproval(
  messages: readonly Message[],
  sessionId: string | null,
): PendingPlanApprovalTarget | null {
  if (!sessionId) return null;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    for (let toolIndex = (message.toolCalls?.length ?? 0) - 1; toolIndex >= 0; toolIndex -= 1) {
      const toolCall = message.toolCalls?.[toolIndex];
      const approval = getPlanApprovalRecord(toolCall);
      if (toolCall && approval?.status === 'pending') {
        return { sessionId, messageId: message.id, toolCallId: toolCall.id, approval };
      }
    }
  }
  return null;
}

export function hasPlanApproval(messages: readonly Message[]): boolean {
  return messages.some((message) => message.toolCalls?.some((toolCall) => getPlanApprovalRecord(toolCall)));
}

export function movePlanStep(
  steps: readonly PlanApprovalStep[],
  sourceIndex: number,
  targetIndex: number,
): PlanApprovalStep[] {
  if (
    sourceIndex === targetIndex
    || sourceIndex < 0
    || targetIndex < 0
    || sourceIndex >= steps.length
    || targetIndex >= steps.length
  ) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function updateMessageWithPlanApproval(
  message: Message,
  toolCallId: string,
  response: PlanApprovalResponse,
): Message {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => (
      toolCall.id === toolCallId && toolCall.result
        ? {
            ...toolCall,
            result: {
              ...toolCall.result,
              metadata: { ...toolCall.result.metadata, planApproval: response.approval },
            },
          }
        : toolCall
    )),
  };
}
