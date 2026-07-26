// ============================================================================
// VoiceCallSummaryCard —— 通话摘要卡（B3）
//
// 消费 metadata.voiceCallSummary（host 挂断时落库的唯一生产者，§7.5），
// 展示时长 / 任务数（>0 才显示——零值是噪音；原始模型 id 属开发者信息，
// 不进用户 UI，产品负责人 2026-07-26 打回）。参与专家列表依赖
// VoiceWorkItem.assignee，那是 Phase 2 字段（§6.7.8），本批不展示。
// ============================================================================

import React from 'react';
import { AudioLines } from 'lucide-react';
import type { VoiceCallSummary } from '@shared/contract/voice';
import { useI18n } from '../../../hooks/useI18n';

export const VoiceCallSummaryCard: React.FC<{ summary: VoiceCallSummary }> = ({ summary }) => {
  const { t } = useI18n();
  const text = t.voice.call;

  const minutes = Math.floor(summary.durationSec / 60);
  const seconds = summary.durationSec % 60;
  const duration =
    minutes > 0 ? `${minutes}${text.minute}${seconds}${text.second}` : `${seconds}${text.second}`;

  return (
    <div data-testid="voice-call-summary-card" className="py-1">
      <div className="flex items-center gap-2.5 rounded-lg border border-primary-500/20 bg-primary-500/5 px-3 py-2">
        <AudioLines className="h-4 w-4 shrink-0 text-primary-400" />
        <span className="shrink-0 text-xs font-medium text-primary-300">{text.summary}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
          <span>{text.duration} {duration}</span>
          {summary.workItemCount > 0 && (
            <span>{text.workItems} {summary.workItemCount}</span>
          )}
        </span>
      </div>
    </div>
  );
};

export default VoiceCallSummaryCard;
