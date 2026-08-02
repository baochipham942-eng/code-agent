// ============================================================================
// VoiceCallSummaryCard —— 通话摘要卡（B3）+ 点击展开文字记录（G1）
// P2 品牌升级：对外叙事名「勘测报告 · 近地轨道 / Survey Report · Low Earth Orbit」，
// 容器换品牌青半透明描边 + teal→透明纵向渐变底，字幕条目前缀 ✦（teal 辉光）。
// 诚实原则：VoiceCallSummary 只有 durationSec/workItemCount/transcriptCount 等
// 计数与时间窗字段，字幕消息只有 role（说话人）——没有任何可映射「稀有度/类型」
// 的字段，所以原型里的稀有度标签不落地；改为卡片底部一行真实计数
// 「本次带回 N 件宝藏」，N = 展开区实际列出的字幕条数。
//
// 消费 metadata.voiceCallSummary（host 挂断时落库的唯一生产者，§7.5），
// 展示时长 / 任务数（>0 才显示——零值是噪音；原始模型 id 属开发者信息，
// 不进用户 UI，产品负责人 2026-07-26 打回）。参与专家列表依赖
// VoiceWorkItem.assignee，那是 Phase 2 字段（§6.7.8），本批不展示。
//
// G1（2026-07-27 拍板）：卡片可点击/键盘展开，内联列出这通电话的字幕——
// 用摘要的 startedAt/endedAt 时间窗 + metadata.source === 'voice' 从当前
// 会话消息里筛，不加新 schema、不建新存储。筛不到时分三档归因，不再一律
// 赖给「旧版本通话」（2026-07-28 工单：没说话的新通话被误报成旧通话）：
// - summary 没有 transcriptCount 字段 → 真·旧记录，明示「未保留（旧版本通话）」；
// - transcriptCount === 0 → 这通电话本来就没对话；
// - transcriptCount > 0 但窗内筛不到 → 有落库但当前会话里找不到，只说「未保留」。
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

  const duration = `${String(Math.floor(summary.durationSec / 60)).padStart(2, '0')}:${String(
    summary.durationSec % 60,
  ).padStart(2, '0')}`;

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
      {/* P2 品牌叙事容器：1px 品牌青半透明描边 + 极浅 teal→透明纵向渐变底（rgba 字面量沿用 VoiceChrome/AgentPointerOverlay 先例，非 hex，不触 ds hex 门） */}
      <div className="rounded-lg border border-[rgba(45,212,191,0.30)] bg-[linear-gradient(180deg,rgba(15,118,110,0.10),transparent)]">
        <button /* ds-allow:button: 摘要卡整行即展开/收起开关（图标+文案复合内容，aria-expanded），非主操作按钮，沿用 bare 先例 */
          type="button"
          aria-expanded={expanded}
          title={expanded ? text.collapse : text.expand}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-400/60"
        >
          <AudioLines className="h-4 w-4 shrink-0 text-primary-400" />
          <span className="shrink-0 text-xs font-medium tracking-[0.14em] text-primary-400">{text.surveyTitle}</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
            <span className="tabular-nums">{text.duration} {duration}</span>
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
              <p className="text-[11px] italic text-zinc-500">
                {summary.transcriptCount === undefined
                  ? text.noTranscriptLegacy
                  : summary.transcriptCount === 0
                    ? text.noTranscriptEmpty
                    : text.noTranscriptMissing}
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-1.5">
                  {transcript.map((m) => (
                    <li key={m.id} className="flex items-baseline gap-2 text-[11px]">
                      {/* ✦ 品牌 teal + 轻微辉光；纯装饰前缀，aria-hidden 不进读屏 */}
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-primary-400 [text-shadow:0_0_6px_rgba(45,212,191,0.5)]"
                      >
                        ✦
                      </span>
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
                {/* 底部真实计数：N = 上面实际列出的字幕条数，不造稀有度标签 */}
                <p className="mt-2 text-[11px] text-zinc-500">
                  {text.treasureCount.replace('{n}', String(transcript.length))}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
