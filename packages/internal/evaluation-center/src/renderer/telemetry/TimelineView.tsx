// ============================================================================
// Timeline View - 事件时间线
// 2026-07-27 评测中心 v2：空态文案改走 i18n，随 EvalTelemetryTab 内嵌进评测中心。
// 2026-09-04 N-EVAL-UX-TIMELINE：折叠 + 事件名人话化。
//
// 为什么要折叠：采集侧把每一条流式增量都当独立事件落库，摘要还是写死的一句
// 「Thinking...」。真机一条 4 轮的 CLI 会话就有 8411 条事件，其中 8204 条是
// Thinking、140 条是 Streaming response——时间线铺出 8411 个 DOM 行、42 万像素高，
// 而真正有信息的只有 18 条（模型路由、工具调用、消息），全被埋掉了
// （爸 09-04 真机报「整列 Thinking… 看不出 agent 在做什么」）。
//
// 折叠放在渲染层而不是采集侧 summarizeEvent：改采集只对以后的新数据生效，
// 库里已有的 47667 条历史事件一条都不会变好。
// ============================================================================

import React, { useMemo } from 'react';
import type { TelemetryTimelineEvent } from '@shared/contract/telemetry';
import { Wrench, MessageSquare, AlertTriangle, Zap, Info, Play, Square } from 'lucide-react';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';

interface TimelineViewProps {
  events: TelemetryTimelineEvent[];
}

const EVENT_ICONS: Record<string, React.FC<{ className?: string }>> = {
  turn_start: Play,
  turn_end: Square,
  tool_call_start: Wrench,
  tool_call_end: Wrench,
  message: MessageSquare,
  error: AlertTriangle,
  stream_reasoning: Zap,
  notification: Info,
};

const EVENT_COLORS: Record<string, string> = {
  turn_start: 'text-badge-success bg-green-500/10',
  turn_end: 'text-zinc-400 bg-zinc-600/10',
  tool_call_start: 'text-badge-info bg-blue-500/10',
  tool_call_end: 'text-badge-info bg-blue-500/10',
  message: 'text-badge-info bg-cyan-500/10',
  error: 'text-badge-danger bg-red-500/10',
  stream_reasoning: 'text-badge-accent bg-purple-500/10',
  notification: 'text-badge-warning bg-amber-500/10',
};

interface TimelineRow {
  event: TelemetryTimelineEvent;
  count: number;
  /** 这一组首末事件的时间跨度，只在折叠了多条时才有意义 */
  spanMs: number;
}

// 采集侧 summarizeEvent 的 default 分支写的就是这个前缀 —— 它等于「这类事件没有摘要」，
// 不是内容。带这个前缀时改用事件名词表；有真摘要的（Model decision / Tool: xxx）原样保留。
const NO_SUMMARY_PREFIX = 'Event: ';

// 这两句同样是采集侧写死的占位（message_delta 按 data.path 二选一），不是事件内容，
// 中文界面里不该原样露出来。key 指向 eventNames 里语义对得上的那一条。
const PLACEHOLDER_SUMMARIES: Record<string, string> = {
  'Thinking...': 'stream_reasoning',
  'Streaming response...': 'message_delta',
};

// 不 export：生产侧只有本组件消费它，导出去就是一个只给测试用的 dead export
// （knip production 棘轮会红）。折叠行为由组件级渲染断言覆盖。
function collapseTimelineEvents(events: TelemetryTimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (last && last.event.eventType === event.eventType && last.event.summary === event.summary) {
      last.count += 1;
      last.spanMs = event.timestamp - last.event.timestamp;
      continue;
    }
    rows.push({ event, count: 1, spanMs: 0 });
  }
  return rows;
}

export const TimelineView: React.FC<TimelineViewProps> = ({ events }) => {
  const { t } = useEvaluationI18n();
  const rows = useMemo(() => collapseTimelineEvents(events), [events]);
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };
  const describe = (event: TelemetryTimelineEvent) => {
    const summary = event.summary ?? '';
    const placeholder = PLACEHOLDER_SUMMARIES[summary];
    if (placeholder) return t.telemetry.eventNames[placeholder] ?? summary;
    if (!summary.startsWith(NO_SUMMARY_PREFIX)) return summary;
    return t.telemetry.eventNames[event.eventType] ?? summary.slice(NO_SUMMARY_PREFIX.length);
  };

  if (events.length === 0) {
    return <div className="text-center text-zinc-500 text-sm py-8">{t.telemetry.emptyEvents}</div>;
  }

  return (
    // 父容器（EvalTelemetryTab 的内容区）已经是 overflow-y-auto，这里不再自带
    // max-h + overflow-y-auto —— 那是在一个滚动区里再套一个滚动区，两条滚动条抢手势。
    <div className="space-y-0.5">
      {rows.map(({ event, count, spanMs }, idx) => {
        const Icon = EVENT_ICONS[event.eventType] ?? Info;
        const colorClass = EVENT_COLORS[event.eventType] ?? 'text-zinc-400 bg-zinc-600/10';

        return (
          <div key={event.id || idx} className="flex items-start gap-2 py-1.5">
            {/* Timeline line */}
            <div className="flex flex-col items-center w-6 shrink-0">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center ${colorClass}`}>
                <Icon className="w-3 h-3" />
              </div>
              {idx < rows.length - 1 && <div className="w-px h-4 bg-zinc-700" />}
            </div>

            {/* Event content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="truncate text-xs text-zinc-400">
                  {describe(event)}
                  {count > 1 && (
                    <span className="ml-1.5 rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-500 tabular-nums">
                      {t.telemetry.eventRepeat.replace('{n}', String(count))}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {count > 1 && spanMs > 0 && (
                    <span className="text-[10px] text-zinc-500 tabular-nums">
                      {t.telemetry.eventSpan.replace('{s}', (spanMs / 1000).toFixed(1))}
                    </span>
                  )}
                  {event.durationMs != null && (
                    <span className="text-[10px] text-zinc-500">{event.durationMs}ms</span>
                  )}
                  <span className="text-[10px] text-zinc-600 font-mono">{formatTime(event.timestamp)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
