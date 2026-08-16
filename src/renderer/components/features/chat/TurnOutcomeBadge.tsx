// ============================================================================
// TurnOutcomeBadge —— TurnCard/任务卡的印章降级态（N-LEDGER-P1）
// ----------------------------------------------------------------------------
// 只认账本里的 turn_outcome 印章：verified 显示「完成有据」，self_claimed
// 显示「自称完成」降级态（与 verified 可区分但不刺眼）；n_a 的终态原因由
// 既有 run 状态 UI 承担，这里不重复；无印章（存量旧会话）不渲染，不臆造。
// 语音派活轮已有自己的结局 UI（voiceWorkOutcome，卡头拍板不转述状态），
// 印章 badge 不与它同屏打架。
// ============================================================================

import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { TraceTurn } from '@shared/contract/trace';
import { useI18n } from '../../../hooks/useI18n';
import { matchStampForTurn, useTurnOutcomeStamps } from '../../../hooks/useTurnOutcomeStamps';

export const TurnOutcomeBadge: React.FC<{ turn: TraceTurn; sessionId?: string }> = ({ turn, sessionId }) => {
  const { t } = useI18n();
  const stamps = useTurnOutcomeStamps(sessionId);
  if (!sessionId || turn.status === 'streaming' || turn.voiceWorkOutcome) return null;
  const stamp = matchStampForTurn(stamps, turn);
  if (!stamp) return null;

  if (stamp.verdict === 'verified') {
    return (
      <span
        data-testid="turn-outcome-badge"
        data-verdict="verified"
        className="inline-flex items-center gap-1 rounded-md border border-badge-success/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-badge-success"
      >
        <CheckCircle2 className="h-3 w-3" />
        {t.sessionInspector.stamp.verified}
      </span>
    );
  }
  if (stamp.verdict === 'self_claimed') {
    return (
      <span
        data-testid="turn-outcome-badge"
        data-verdict="self_claimed"
        className="inline-flex items-center gap-1 rounded-md border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-badge-warning"
      >
        <AlertTriangle className="h-3 w-3" />
        {t.sessionInspector.stamp.selfClaimed}
      </span>
    );
  }
  return null;
};
