// ============================================================================
// BackgroundRunSettlement - run 终态 → 后台条目收线决策（N-RUNINPUT-TOBACKGROUND-OPTION rework）
// ============================================================================
// 2026-10-11 无槽验收：后台任务撞 max-step 上限结束后面板/侧栏 spinner 永不收线——
// 收口点只认 completed，失败/取消/撞顶轮全部漏掉。这里把「每个终态都必须收线」的
// 决策钉成纯函数，web 直连轮（agent.ts）与桌面 orchestrator 轮（TaskManager）共用。
// 消息传稳定 code（MAX_ITERATIONS / USER_CANCELLED），友好文案由 renderer i18n 翻译。

import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../shared/constants';

export interface BackgroundRunSettlementInput {
  /** run 的终态（web 路的 finalStatus / 桌面路按事件流推导）。 */
  status: 'completed' | 'error' | 'interrupted';
  /** run 级 error 事件的消息（失败收线时展示）。 */
  errorMessage?: string;
  /** run 级 error 事件的稳定 code（max-step 撞顶等，renderer 据此翻译）。 */
  errorCode?: string;
}

export interface BackgroundRunSettlement {
  action: 'markCompleted' | 'markFailed';
  message?: string;
}

/**
 * 把 run 终态映射成后台条目的收线动作：
 * - completed → markCompleted（无消息，面板显示默认完成行）；
 * - interrupted（取消/中断）→ markCompleted + USER_CANCELLED 标记（不是失败，用户主动停）；
 * - error → markFailed；max-step 撞顶传稳定 code 而非英文内部串，其余传原始 message。
 */
export function resolveBackgroundRunSettlement(input: BackgroundRunSettlementInput): BackgroundRunSettlement {
  if (input.status === 'error') {
    return {
      action: 'markFailed',
      message: input.errorCode === RUN_ERROR_CODE_MAX_ITERATIONS
        ? RUN_ERROR_CODE_MAX_ITERATIONS
        : input.errorMessage,
    };
  }
  if (input.status === 'interrupted') {
    return { action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED };
  }
  return { action: 'markCompleted' };
}

interface BackgroundTaskManagerLike {
  markCompleted(sessionId: string, message?: string): Promise<void> | void;
  markFailed(sessionId: string, error?: string): void;
}

/** 按决策收线。markCompleted/markFailed 自带 running-guard，重复收线是幂等 no-op。 */
export async function settleBackgroundRun(
  backgroundManager: BackgroundTaskManagerLike,
  sessionId: string,
  settlement: BackgroundRunSettlement,
): Promise<void> {
  if (settlement.action === 'markFailed') {
    backgroundManager.markFailed(sessionId, settlement.message);
    return;
  }
  await backgroundManager.markCompleted(sessionId, settlement.message);
}
