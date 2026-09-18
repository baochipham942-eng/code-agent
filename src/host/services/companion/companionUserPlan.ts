import type { Message, ToolCall } from '../../../shared/contract';
import {
  PLAN_APPROVAL_CONFIRMATION_TYPE,
  type PlanApprovalRecord,
  type PlanApprovalRequest,
} from '../../../shared/contract/planApproval';
import { getDatabase } from '../core/databaseService';
import { getTaskManager } from '../../task/TaskManager';
import { resolvePlanApproval } from '../planning/planApprovalService';
import { createLogger } from '../infra/logger';
import type { CompanionDecisionOutcome, CompanionPlanAnswer } from '../../../shared/contract/companion';
import { companionRequestId, type CompanionPlanRequest } from './CompanionPlanService';

export type CompanionPlanInspection = {
  outcome: CompanionDecisionOutcome;
  answer?: CompanionPlanAnswer;
};

const logger = createLogger('CompanionUserPlan');

/**
 * ChatView exit_plan_mode cards live in session message metadata, not PlanApprovalGate.
 * Keep an in-memory set populated from tool_call_end so phone sync can project them
 * without scanning every session on every poll.
 *
 * ponytail: Map is process-local. Host restart drops pending cards until the next
 * tool_call_end; expiry only inspects the latest 20 messages, so a card the desktop
 * already resolved behind a long offline gap can still show until the 40-message
 * deliver window marks it closed.
 */
const pending = new Map<string, { sessionId: string; toolCallId: string; plan: string }>();
const settlements = new Map<string, CompanionPlanInspection>();

export type CompanionPlanRunOptions = { historyVisibility?: 'meta'; disableAutoAgent?: boolean };

function companionPlanRunFromEnvelope(
  envelope: { content?: unknown; sessionId?: unknown; options?: Record<string, unknown> },
  fallback: { sessionId: string; plan: string },
): { sessionId: string; prompt: string } & CompanionPlanRunOptions {
  const prompt = typeof envelope.content === 'string' ? envelope.content : fallback.plan;
  const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : fallback.sessionId;
  const options = envelope.options && typeof envelope.options === 'object' ? envelope.options : {};
  return {
    sessionId,
    prompt,
    ...(options.historyVisibility === 'meta' ? { historyVisibility: 'meta' as const } : {}),
    ...(options.disableAutoAgent === true ? { disableAutoAgent: true } : {}),
  };
}

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
    rememberUserPlanSettlement(toolCallId, status, approval && typeof approval === 'object' && !Array.isArray(approval)
      ? (approval as { feedback?: unknown }).feedback
      : undefined);
    return true;
  }
  pending.set(toolCallId, { sessionId, toolCallId, plan });
  return true;
}

/**
 * 手机上真挂着这张卡的 pending 行时，结算桥才有消费者（take）。
 * 没配对手机/卡从未发布的结算没有人 take，记下来只会在进程内只增不减（ai-review R5）。
 * 表读不出来（companion 未接线/表不存在）= 不可能有手机卡，跳过同样正确。
 */
function hasPendingPhoneCard(requestId: string): boolean {
  const db = readyDb();
  if (!db) return false;
  try {
    const row = db.getDb()?.prepare(
      "SELECT 1 FROM companion_decisions WHERE request_id = ? AND status = 'pending' AND kind = 'plan'",
    ).get(companionRequestId(requestId));
    return row !== undefined;
  } catch (error) {
    logger.warn('Companion plan card probe failed, skipping settlement', { requestId, error });
    return false;
  }
}

function rememberUserPlanSettlement(requestId: string, status: unknown, feedback: unknown): void {
  if (!hasPendingPhoneCard(requestId)) return;
  const text = typeof feedback === 'string' && feedback.trim() ? feedback : undefined;
  if (status === 'approved') {
    settlements.set(requestId, { outcome: 'answered', answer: { decision: 'approved', ...(text ? { feedback: text } : {}) } });
    return;
  }
  if (status === 'revision_requested') {
    settlements.set(requestId, { outcome: 'answered', answer: { decision: 'rejected', ...(text ? { feedback: text } : {}) } });
    return;
  }
  settlements.set(requestId, { outcome: 'cancelled' });
}

export function takeCompanionUserPlanSettlement(requestId: string): CompanionPlanInspection | null {
  const next = settlements.get(requestId) ?? null;
  if (next) settlements.delete(requestId);
  return next;
}

export function listCompanionUserPlans(): CompanionPlanRequest[] {
  const db = readyDb();
  const live: CompanionPlanRequest[] = [];
  for (const [id, item] of [...pending]) {
    if (db) {
      // 这次读只用来**修剪**已不在待审批态的卡；瞬时数据库故障时不许让整个列表轮询抛错
      // （ai-review round10 Important）——读不到就保守保留这张卡，下一拍轮询再修。
      let messages: Message[] = [];
      try {
        messages = db.getRecentMessages(item.sessionId, 20) as Message[];
      } catch (error) {
        logger.warn('Companion plan prune read failed, keeping pending card', { sessionId: item.sessionId, toolCallId: item.toolCallId, error });
      }
      const toolCall = messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === item.toolCallId);
      if (toolCall && !readPendingApproval(toolCall)) {
        const approval = toolCall.result?.metadata?.planApproval as { status?: unknown; feedback?: unknown } | undefined;
        rememberUserPlanSettlement(id, approval?.status, approval?.feedback);
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
  startRun: (sessionId: string, prompt: string, options?: CompanionPlanRunOptions) => Promise<unknown>,
): { success: boolean; data?: { closed?: boolean } } {
  const item = pending.get(planId);
  if (item?.sessionId !== sessionId) return { success: false, data: { closed: true } };
  const db = readyDb();
  if (!db?.isReady) return { success: false, data: { closed: true } };
  // 全量回读（与桌面 loadApprovalTarget 的 getMessages 同款）：审批是用户在手机上
  // 点击触发的一次性动作，经得起全量读；固定窗口会让滑出窗口的计划卡变僵尸——
  // 手机仍显示待批，deliver 却永远 closed（ai-review 2026-09-14）。瞬时 DB 故障
  // 转成可控关闭，不让它顺着审批路径直接抛出去（同轮 Nit）。
  let messages: Message[];
  try {
    messages = db.getMessages(sessionId) as Message[];
  } catch {
    return { success: false, data: { closed: true } };
  }
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
      sendMessage: async (envelope: { content?: string; sessionId?: string; options?: Record<string, unknown> }) => {
        const run = companionPlanRunFromEnvelope(envelope, { sessionId, plan: item.plan });
        await startRun(run.sessionId, run.prompt, {
          ...(run.historyVisibility ? { historyVisibility: run.historyVisibility } : {}),
          ...(run.disableAutoAgent ? { disableAutoAgent: true } : {}),
        });
      },
    } as never,
    taskManager: getTaskManager(),
  }).catch((error) => {
    logger.warn('Companion user plan delivery failed', error);
  });
  return { success: true };
}
