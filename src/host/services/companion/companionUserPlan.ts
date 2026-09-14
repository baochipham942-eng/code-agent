import type { Message, ToolCall } from '../../../shared/contract';
import {
  PLAN_APPROVAL_CONFIRMATION_TYPE,
  isRetryablePlanApprovalStatus,
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

/** Card-alive statuses: pending / starting / failed all keep the card projected. */
function readCardApproval(toolCall: ToolCall | undefined): PlanApprovalRecord | null {
  const value = toolCall?.result?.metadata?.planApproval;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as unknown as PlanApprovalRecord;
  if (!Array.isArray(record.steps) || typeof record.originalPlan !== 'string') return null;
  if (record.status !== 'pending' && record.status !== 'starting' && record.status !== 'failed') return null;
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
    let failure: { failureReason: string; failedAt?: number } | undefined;
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
      const card = readCardApproval(toolCall);
      if (toolCall && !card) {
        const approval = toolCall.result?.metadata?.planApproval as { status?: unknown; feedback?: unknown } | undefined;
        rememberUserPlanSettlement(id, approval?.status, approval?.feedback);
        pending.delete(id);
        continue;
      }
      // 失败字段只在 failed 落定时写入、认领（starting）不清除：投影在「失败后重试启动中」
      // 与「失败」之间保持一致，手机端 operationDigest 稳定，starting 不会被误重发布；
      // 再败必换 failedAt，digest 必变，卡片必重现。
      if (card && typeof card.failureReason === 'string' && card.failureReason) {
        failure = { failureReason: card.failureReason, ...(typeof card.failedAt === 'number' ? { failedAt: card.failedAt } : {}) };
      }
    }
    live.push({
      id: item.toolCallId,
      sessionId: item.sessionId,
      plan: item.plan,
      ...(failure ?? {}),
    });
  }
  return live;
}

export async function deliverCompanionUserPlan(
  planId: string,
  approved: boolean,
  feedback: string | undefined,
  sessionId: string,
  startRun: (sessionId: string, prompt: string, options?: CompanionPlanRunOptions) => Promise<unknown>,
): Promise<{ success: boolean; data?: { closed?: boolean } }> {
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
  const approval = readCardApproval(toolCall);
  if (!message || !approval) return { success: false, data: { closed: true } };
  // starting 已被并发决定认领：closed 而不是再起一轮，重试走同一记录不双跑。
  if (!isRetryablePlanApprovalStatus(approval.status)) return { success: false, data: { closed: true } };
  const revision = feedback?.trim();
  const decision: PlanApprovalRequest['decision'] = approved ? 'approve' : (revision ? 'revise' : 'cancel');
  const request: PlanApprovalRequest = {
    sessionId,
    messageId: message.id,
    toolCallId: item.toolCallId,
    decision,
    ...(decision === 'approve' ? { steps: approval.steps } : {}),
    ...(revision && decision === 'revise' ? { feedback: revision } : {}),
  };
  try {
    await resolvePlanApproval(request, {
      appService: {
        sendMessage: async (envelope: { content?: string; sessionId?: string; options?: Record<string, unknown> }) => {
          const run = companionPlanRunFromEnvelope(envelope, { sessionId, plan: item.plan });
          await startRun(run.sessionId, run.prompt, {
            ...(run.historyVisibility ? { historyVisibility: run.historyVisibility } : {}),
            ...(run.disableAutoAgent ? { disableAutoAgent: true } : {}),
          });
          // 启动确认（web companionRun 在 durable activation 时 resolve）：卡片使命
          // 完成，下一轮 list 不再发布。启动失败则抛出——记录转 failed 带原因，卡片
          // 以 failed 投影重新发布，可再批准/取消。
          pending.delete(planId);
        },
      } as never,
      taskManager: getTaskManager(),
    });
  } catch (error) {
    // claim 阶段失败（ALREADY_RESOLVED / 参数校验 / DB 故障）：卡片保留原状态，
    // 返回可控关闭让手机端拿到 approval_conflict 而不是假 resolved。
    logger.warn('Companion user plan delivery failed', error);
    return { success: false, data: { closed: true } };
  }
  return { success: true };
}
