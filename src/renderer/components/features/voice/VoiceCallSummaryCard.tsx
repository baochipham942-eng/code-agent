// ============================================================================
// VoiceCallSummaryCard —— 通话摘要卡（B3）+ 点击展开文字记录（G1）
//
// 消费 metadata.voiceCallSummary（host 挂断时落库的唯一生产者，§7.5），
// 展示时长 / 任务数（>0 才显示——零值是噪音；原始模型 id 属开发者信息，
// 不进用户 UI，产品负责人 2026-07-26 打回）。参与专家列表依赖
// VoiceWorkItem.assignee，那是 Phase 2 字段（§6.7.8），本批不展示。
//
// G1（2026-07-27 拍板）：卡片可点击/键盘展开，内联列出这通电话的字幕——
// 用摘要的 startedAt/endedAt 时间窗 + metadata.source === 'voice' 从当前
// 会话消息里筛，不加新 schema、不建新存储。排水窗修复（#733）之前的旧通话
// 没有字幕落库，展开后明示「文字记录未保留」，不装死不空白。
// ============================================================================

import React from 'react';
import { AudioLines, ChevronDown } from 'lucide-react';
import type { VoiceCallSummary } from '@shared/contract/voice';
import { isVoiceInputMessage } from '@shared/contract/message';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';

export const VoiceCallSummaryCard: React.FC<{ summary: VoiceCallSummary }> = ({ summary }) => {
  const { t } = useI18n();
  const text = t.voice.call;
  const [expanded, setExpanded] = React.useState(false);
  const messages = useSessionStore((s) => s.messages);

  const minutes = Math.floor(summary.durationSec / 60);
  const seconds = summary.durationSec % 60;
  const duration =
    minutes > 0 ? `${minutes}${text.minute}${seconds}${text.second}` : `${seconds}${text.second}`;

  // 字幕真源 = 当前会话消息流里 source=voice 的 user/assistant 消息，
  // 时间落在本通电话的 [startedAt, endedAt] 窗内（summary 自身是 system 消息，
  // role 过滤天然把它排除；多次通话时间窗互不相交，不会串台）。
  const transcript = React.useMemo(
    () =>
      messages.filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          isVoiceInputMessage(m) &&
          m.timestamp >= summary.startedAt &&
          m.timestamp <= summary.endedAt,
      ),
    [messages, summary.startedAt, summary.endedAt],
  );

  return (
    <div data-testid="voice-call-summary-card" className="py-1">
      <div className="rounded-lg border border-primary-500/20 bg-primary-500/5">
        <button /* ds-allow:button: 摘要卡整行即展开/收起开关（图标+文案复合内容，aria-expanded），非主操作按钮，沿用 bare 先例 */
          type="button"
          aria-expanded={expanded}
          title={expanded ? text.collapse : text.expand}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-400/60"
        >
          <AudioLines className="h-4 w-4 shrink-0 text-primary-400" />
          <span className="shrink-0 text-xs font-medium text-primary-300">{text.summary}</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
            <span>{text.duration} {duration}</span>
            {summary.workItemCount > 0 && (
              <span>{text.workItems} {summary.workItemCount}</span>
            )}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
        {expanded && (
          <div className="border-t border-primary-500/15 px-3 py-2">
            {transcript.length === 0 ? (
              <p className="text-[11px] italic text-zinc-500">{text.noTranscript}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {transcript.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-2 text-[11px]">
                    <span
                      className={`shrink-0 font-medium ${
                        m.role === 'user' ? 'text-primary-300' : 'text-zinc-300'
                      }`}
                    >
                      {m.role === 'user' ? t.voice.transcript.you : t.voice.transcript.assistant}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-zinc-400">
                      {m.content}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
                      {new Date(m.timestamp).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default VoiceCallSummaryCard;
