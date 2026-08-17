// ============================================================================
// 装卸历史（N-LEDGER-P5）—— 能力中心第 6 个 tab
// ----------------------------------------------------------------------------
// 把 capability-runtime 账本里的 capability_lifecycle 四类事件
// （loaded / unloaded / rolled_back / failed）按能力单元分组，只读时间线展示。
//
// 三条纪律（与候选能力 tab 同款）：
//   1. 零打断：只有拉式——没有订阅、没有轮询、没有红点。挂载和用户点刷新各拉一次。
//   2. 只读：本屏没有任何干预操作（不做装载/卸载/重试按钮）。
//   3. 人话：UI 只出现「装上了 / 卸下了 / 回滚了 / 失败了」，
//      unit / lifecycle / trace / 账本 / rollback 一个都不许进文案。
//
// 噪声吸收：synchronizeSkillCapabilitySurface 任一技能签名变化就全量
// unload + load（一次变更 = N 条 unloaded + N 条 loaded）。按能力分组 +
// 组内默认只展开最近 3 条把这种爆发收进各自组里，不做全局大流水。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchSessionTrace, type TraceSessionRead } from '../../../services/traceLedgerClient';
import {
  projectCapabilityLifecycleHistory,
  type CapabilityLifecycleAction,
  type CapabilityLifecycleEntry,
  type CapabilityLifecycleGroup,
} from '../../../utils/capabilityLifecycleHistory';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { HubTabHeader } from './HubTabHeader';

/** 写侧 sessionId 字面量（skillCapabilitySurface.ts）：全量装卸历史恒落这一个会话账本 */
const CAPABILITY_RUNTIME_SESSION = 'capability-runtime';
/** 组内默认展开最近 3 条，其余折叠吸收 rebuild 爆发 */
const DEFAULT_VISIBLE = 3;

type HistoryText = ReturnType<typeof useI18n>['t']['capabilityHistory'];

/** 动作点色只用主题感知的 bg-mark-* token；文字一律中性色 */
function actionDot(action: CapabilityLifecycleAction): string {
  if (action === 'loaded') return 'bg-mark-info';
  if (action === 'unloaded') return 'bg-mark-neutral';
  if (action === 'rolled_back') return 'bg-mark-warning';
  return 'bg-mark-danger';
}

function actionLabel(action: CapabilityLifecycleAction, text: HistoryText): string {
  if (action === 'loaded') return text.actionLoaded;
  if (action === 'unloaded') return text.actionUnloaded;
  if (action === 'rolled_back') return text.actionRolledBack;
  return text.actionFailed;
}

interface EventRowProps {
  entry: CapabilityLifecycleEntry;
  text: HistoryText;
  relativeTime: (ts: number) => string;
  absoluteTime: (ts: number) => string;
}

const EventRow: React.FC<EventRowProps> = ({ entry, text, relativeTime, absoluteTime }) => (
  <li
    data-testid="capability-history-event"
    data-capability-key={entry.capabilityKey}
    data-action={entry.action}
    className="flex items-start gap-2.5 py-1.5"
  >
    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${actionDot(entry.action)}`} />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-zinc-200">{actionLabel(entry.action, text)}</span>
        <span className="shrink-0 text-xs text-zinc-500" title={absoluteTime(entry.ts)}>
          {relativeTime(entry.ts)}
        </span>
      </div>
      {/* failed 的 detail 是 host 的 error.message：原文展示，不翻译不加工 */}
      {entry.detail ? (
        <p className="mt-0.5 break-words text-xs text-zinc-500">{entry.detail}</p>
      ) : null}
    </div>
  </li>
);

interface GroupCardProps {
  group: CapabilityLifecycleGroup;
  text: HistoryText;
  relativeTime: (ts: number) => string;
  absoluteTime: (ts: number) => string;
}

const GroupCard: React.FC<GroupCardProps> = ({ group, text, relativeTime, absoluteTime }) => {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.entries : group.entries.slice(0, DEFAULT_VISIBLE);
  const foldedCount = group.entries.length - DEFAULT_VISIBLE;
  return (
    <section
      data-testid="capability-history-group"
      data-capability-key={group.capabilityKey}
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="truncate text-sm font-medium text-zinc-100">{group.capabilityKey}</h2>
        <span className="shrink-0 text-xs text-zinc-500">
          {text.entryCount.replace('{count}', String(group.entries.length))}
        </span>
      </div>
      <ul className="mt-1 divide-y divide-zinc-800/60">
        {visible.map((entry, index) => (
          <EventRow
            key={`${entry.ts}-${index}`}
            entry={entry}
            text={text}
            relativeTime={relativeTime}
            absoluteTime={absoluteTime}
          />
        ))}
      </ul>
      {foldedCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setExpanded((open) => !open)}
          data-testid="capability-history-fold-toggle"
        >
          {expanded ? text.hideMore : text.showMore.replace('{count}', String(foldedCount))}
        </Button>
      ) : null}
    </section>
  );
};

export const CapabilityLifecycleHistoryTab: React.FC = () => {
  const { t, language } = useI18n();
  const text = t.capabilityHistory;
  const [read, setRead] = useState<TraceSessionRead | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 失败（无 webServer / 鉴权 / 网络）一律 null → 走空态，不臆造账本内容
      setRead(await fetchSessionTrace(CAPABILITY_RUNTIME_SESSION));
    } catch {
      setRead(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 只在进这一屏时拉一次；没有订阅、没有定时器——回看视图是拉式的。
  useEffect(() => { void load(); }, [load]);

  const relativeTime = useCallback(
    (ts: number) => (ts > 0 ? formatRelativeTime(t, ts) : '—'),
    [t],
  );
  const absoluteTime = useCallback(
    (ts: number) => (ts > 0 ? new Date(ts).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : ''),
    [language],
  );

  const history = read?.state === 'present'
    ? projectCapabilityLifecycleHistory(read.events)
    : { groups: [], dropped: 0 };

  return (
    <div data-testid="capability-history-tab">
      <HubTabHeader
        title={text.title}
        actions={(
          <IconButton
            icon={<RefreshCw className="h-4 w-4" />}
            aria-label={text.refresh}
            title={text.refresh}
            onClick={() => { void load(); }}
            disabled={loading}
          />
        )}
      />
      <p className="mb-3 text-xs text-zinc-500">{text.intro}</p>

      {history.groups.length === 0 ? (
        <EmptyState variant="panel" title={text.emptyTitle} text={text.emptyText} />
      ) : (
        <div className="space-y-2">
          {history.groups.map((group) => (
            <GroupCard
              key={group.capabilityKey}
              group={group}
              text={text}
              relativeTime={relativeTime}
              absoluteTime={absoluteTime}
            />
          ))}
        </div>
      )}
    </div>
  );
};
