import type { Message, ToolCall } from '../../../shared/contract';
import {
  PLAN_APPROVAL_CONFIRMATION_TYPE,
  type PlanApprovalRecord,
  type PlanApprovalRequest,
} from '../../../shared/contract/planApproval';
import { getDatabase } from '../core/databaseService';
import { getTaskManager } from '../../task/TaskManager';
import { resolvePlanApproval } from '../planning/planApprovalService';
import type { CompanionPlanRequest } from './CompanionPlanService';

/**
 * ChatView exit_plan_mode cards live in session message metadata, not PlanApprovalGate.
 * Keep an in-memory set populated from tool_call_end so phone sync can project them
 * without scanning every session on every poll.
 */
const pending = new Map<string, { sessionId: string; toolCallId: string; plan: string }>();

function readPendingApproval(toolCall: ToolCall | undefined): PlanApprovalRecord | null {
  const value = toolCall?.result?.metadata?.planApproval;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as unknown as PlanApprovalRecord;
  if (!Array.isArray(record.steps) || typeof record.originalPlan !== 'string') return null;
  if (record.status !== 'pending') return null;
  return record;
}

function readyDb() {
  try {
    const db = getDatabase();
    return db.isReady ? db : null;
  } catch {
    return null;
  }
}

/** Returns true when a new pending card was registered. */
export function noteCompanionUserPlan(sessionId: string, event: Record<string, unknown>): boolean {
  const metadata = event.metadata;
  if (!sessionId || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const meta = metadata as Record<string, unknown>;
  if (meta.confirmationType !== PLAN_APPROVAL_CONFIRMATION_TYPE) return false;
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
  const plan = typeof meta.plan === 'string' ? meta.plan : '';
  if (!toolCallId || !plan.trim()) return false;
  const approval = meta.planApproval;
  const status = approval && typeof approval === 'object' && !Array.isArray(approval)
    ? (approval as { status?: unknown }).status
    : 'pending';
  if (status !== 'pending') {
    pending.delete(toolCallId);
    return false;
  }
  pending.set(toolCallId, { sessionId, toolCallId, plan });
  return true;
}

export function listCompanionUserPlans(): CompanionPlanRequest[] {
  const db = readyDb();
  const live: CompanionPlanRequest[] = [];
  for (const [id, item] of [...pending]) {
    if (db) {
      const messages = db.getRecentMessages(item.sessionId, 20) as Message[];
      const toolCall = messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === item.toolCallId);
      if (toolCall && !readPendingApproval(toolCall)) {
        pending.delete(id);
        continue;
      }
    }
    live.push({ id: item.toolCallId, sessionId: item.sessionId, plan: item.plan });
  }
  return live;
}

export function deliverCompanionUserPlan(
  planId: string,
  approved: boolean,
  feedback: string | undefined,
  sessionId: string,
  startRun: (sessionId: string, prompt: string) => void,
): { success: boolean; data?: { closed?: boolean } } {
  const item = pending.get(planId);
  if (item?.sessionId !== sessionId) return { success: false, data: { closed: true } };
  const db = readyDb();
  if (!db?.isReady) return { success: false, data: { closed: true } };
  const messages = db.getRecentMessages(sessionId, 40) as Message[];
  const message = messages.find(entry => entry.toolCalls?.some(call => call.id === item.toolCallId));
  const toolCall = message?.toolCalls?.find(call => call.id === item.toolCallId);
  const approval = readPendingApproval(toolCall);
  if (!message || !approval) return { success: false, data: { closed: true } };
  const revision = feedback?.trim();
  const decision: PlanApprovalRequest['decision'] = approved ? 'approve' : (revision ? 'revise' : 'cancel');
  pending.delete(planId);
  const request: PlanApprovalRequest = {
    sessionId,
    messageId: message.id,
    toolCallId: item.toolCallId,
    decision,
    ...(decision === 'approve' ? { steps: approval.steps } : {}),
    ...(revision && decision === 'revise' ? { feedback: revision } : {}),
  };
  void resolvePlanApproval(request, {
    appService: {
      sendMessage: async (envelope: { content?: string; sessionId?: string }) => {
        const prompt = typeof envelope.content === 'string' ? envelope.content : item.plan;
        startRun(envelope.sessionId ?? sessionId, prompt);
        return undefined as never;
      },
    } as never,
    taskManager: getTaskManager(),
  }).catch(() => {});
  return { success: true };
}
