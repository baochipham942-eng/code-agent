import type { ToolCall } from '../../../shared/contract';
import {
  isRetryablePlanApprovalStatus,
  PLAN_APPROVAL_CONFIRMATION_TYPE,
  type PlanApprovalRecord,
} from '../../../shared/contract/planApproval';
import { getDatabase } from '../core/databaseService';
import { createLogger } from '../infra/logger';

/** 与启动对账共用的每会话近期消息窗口。 */
export const RECONCILE_MESSAGE_WINDOW = 20;

const logger = createLogger('PlanApprovalService');

function toolCallHasRetryablePlanApproval(toolCall: ToolCall): boolean {
  const metadata = toolCall.result?.metadata;
  if (
    metadata?.confirmationType !== PLAN_APPROVAL_CONFIRMATION_TYPE
    || typeof metadata.plan !== 'string'
  ) {
    return false;
  }
  const approval = metadata.planApproval;
  // 缺 planApproval 对象时与 readApproval 一样视作 pending。来源不参与判定。
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return true;
  return isRetryablePlanApprovalStatus((approval as PlanApprovalRecord).status);
}

/**
 * 近期消息窗口里是否还有可重试的计划卡（pending / failed）。
 * 窗口与 DB 访问与启动对账相同。库不可用时失败打开并记日志：看不到卡就不能把它当成还在等审批。
 */
export function hasPendingPlanApproval(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch (error) {
    logger.warn('Pending plan approval check skipped: database unavailable', { sessionId, error });
    return false;
  }
  if (!db?.isReady) {
    logger.warn('Pending plan approval check skipped: database not ready', { sessionId });
    return false;
  }
  try {
    const messages = db.getRecentMessages(sessionId, RECONCILE_MESSAGE_WINDOW);
    if (!Array.isArray(messages)) {
      logger.warn('Pending plan approval check skipped: database unavailable', { sessionId });
      return false;
    }
    for (const message of messages) {
      for (const toolCall of message.toolCalls ?? []) {
        if (toolCallHasRetryablePlanApproval(toolCall)) return true;
      }
    }
  } catch (error) {
    logger.warn('Pending plan approval check skipped: database unavailable', { sessionId, error });
    return false;
  }
  return false;
}
