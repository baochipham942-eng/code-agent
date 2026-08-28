import {
  HostReasonCode,
  isHostReasonPayload,
  type HostReasonValue,
} from '@shared/contract';
import type { GoalNoticePayload } from '../components/features/chat/goalNotice';
import type { Translations } from '../i18n';
import type { GoalRunState } from '../stores/appStore';
import { resolveHostReasonCopy } from './hostReasonPresentation';

export interface GoalCompletePresentationData {
  status: 'met' | 'aborted';
  reason?: HostReasonValue;
  turns: number;
  tokensUsed: number;
  degraded?: boolean;
  degradedReason?: string;
}

export interface GoalCompletePresentation {
  stateReason?: string;
  notice: GoalNoticePayload | null;
}

/**
 * goal_complete 的唯一用户投影：运行失败由紧随其后的 AgentErrorPresentation 承接；
 * 其余中止在这里转成人话卡。任何原始原因、轮次和 token 都不进入中止卡 payload。
 */
export function projectGoalCompletePresentation(
  data: GoalCompletePresentationData,
  run: GoalRunState | undefined,
  t: Translations,
  now = Date.now(),
): GoalCompletePresentation {
  if (data.status === 'met') {
    return {
      notice: {
        kind: 'met',
        goal: run?.goal ?? '',
        turns: data.turns,
        tokensUsed: data.tokensUsed,
        durationMs: run ? now - run.startedAt : undefined,
        degraded: data.degraded,
        degradedReason: data.degradedReason,
        verificationCard: [...(run?.gates ?? [])]
          .reverse()
          .find((gate) => gate.verificationCard)?.verificationCard,
      },
    };
  }

  const copy = resolveHostReasonCopy(data.reason, t);
  const stateReason = copy?.summary;
  if (
    isHostReasonPayload(data.reason)
    && data.reason.code === HostReasonCode.GoalAbortRuntimeFailure
  ) {
    return { stateReason, notice: null };
  }

  return {
    stateReason,
    notice: {
      kind: 'aborted',
      goal: '',
      reason: stateReason ?? t.agentError.categories.generic.title,
      suggestion: copy?.detail ?? t.agentError.categories.generic.suggestion,
    },
  };
}
