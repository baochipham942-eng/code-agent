// ============================================================================
// 装卸历史（N-LEDGER-P5B）—— 能力中心第 6 个 tab
// ----------------------------------------------------------------------------
// 把 capability-runtime 账本里的 capability_lifecycle 四类事件
// （loaded / unloaded / rolled_back / failed）按批次（时间簇）聚成一行一条，
// 批内列能力名字，只读展示。
//
// 三条纪律（与候选能力 tab 同款）：
//   1. 零打断：只有拉式——没有订阅、没有轮询、没有红点。挂载和用户点刷新各拉一次。
//   2. 只读：本屏没有任何干预操作（不做装载/卸载/重试按钮）。
//   3. 人话：UI 只出现「装上了 / 卸下了 / 回滚了 / 失败了」，
//      unit / lifecycle / trace / 账本 / rollback / batch / 批次 一个都不许进文案。
//
// 噪声吸收（P5B 方案 B）：synchronizeSkillCapabilitySurface 任一技能签名变化
// 就全量 unload + load（一次变更 = 一批 ~50 条 unloaded + 一批 ~50 条 loaded）。
// 批次主轴把爆发聚成一行；多能力批次默认折叠，展开是名字的横向流式列表
// （50 个名字约 3 行），绝不做成一个能力一行——那是把噪音搬回来。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchSessionTrace, type TraceSessionRead } from '../../../services/traceLedgerClient';
import {
  projectCapabilityLifecycleHistory,
  sharedNamespaceKey,
  splitCapabilityKey,
  type CapabilityLifecycleAction,
  type CapabilityLifecycleBatch,
} from '../../../utils/capabilityLifecycleHistory';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { HubTabHeader } from './HubTabHeader';

/** 写侧 sessionId 字面量（skillCapabilitySurface.ts）：全量装卸历史恒落这一个会话账本 */
const CAPABILITY_RUNTIME_SESSION = 'capability-runtime';

type HistoryText = ReturnType<typeof useI18n>['t']['capabilityHistory'];

/** 动作点色只用主题感知的 bg-mark-* token；文字一律中性色 */
function actionDot(action: CapabilityLifecycleAction): string {
  if (action === 'loaded') return 'bg-mark-info';
  if (action === 'unloaded') return 'bg-mark-neutral';
  if (action === 'rolled_back') return 'bg-mark-warning';
  return 'bg-mark-danger';
}

/** 命名空间是实现概念，不许直接上屏：`skill:foo` → 「技能 · foo」；认不出的原样露出 */
function capabilityDisplayName(capabilityKey: string, text: HistoryText): string {
  const split = splitCapabilityKey(capabilityKey);
  return split ? `${text[split.namespaceKey]} · ${split.name}` : capabilityKey;
}

function actionLabel(action: CapabilityLifecycleAction, text: HistoryText): string {
  if (action === 'loaded') return text.actionLoaded;
  if (action === 'unloaded') return text.actionUnloaded;
  if (action === 'rolled_back') return text.actionRolledBack;
  return text.actionFailed;
}

interface BatchRowProps {
  batch: CapabilityLifecycleBatch;
  text: HistoryText;
  relativeTime: (ts: number) => string;
  absoluteTime: (ts: number) => string;
}

const BatchRow: React.FC<BatchRowProps> = ({ batch, text, relativeTime, absoluteTime }) => {
  const [expanded, setExpanded] = useState(false);
  const label = actionLabel(batch.action, text);
  const single = batch.capabilityKeys.length === 1;
  // 整批同属一个命名空间时，名单里的名字不再各带一遍「技能 ·」（50 遍等于噪音）；
  // 混合批里命名空间是真区分信息，逐个保留。单能力批走行内形态，始终带。
  const homogeneous = sharedNamespaceKey(batch.capabilityKeys) !== null;
  return (
    <section
      data-testid="capability-history-batch"
      data-action={batch.action}
      data-count={batch.capabilityKeys.length}
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${actionDot(batch.action)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-zinc-200">
              {single
                // 只有 1 个能力时名字直接写进行里，不废一步「1 个能力 + 展开」
                ? `${label} · ${capabilityDisplayName(batch.capabilityKeys[0], text)}`
                : `${label} ${text.batchCount.replace('{count}', String(batch.capabilityKeys.length))}`}
            </span>
            <span className="shrink-0 text-xs text-zinc-500" title={absoluteTime(batch.ts)}>
              {relativeTime(batch.ts)}
            </span>
          </div>
          {/* failed 的 detail 是 host 的 error.message：原文展示，不翻译不加工 */}
          {single && batch.details[batch.capabilityKeys[0]] ? (
            <p className="mt-0.5 break-words text-xs text-zinc-500">
              {batch.details[batch.capabilityKeys[0]]}
            </p>
          ) : null}
        </div>
      </div>
      {!single ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            onClick={() => setExpanded((open) => !open)}
            data-testid="capability-history-fold-toggle"
          >
            {expanded ? text.hideMembers : text.showMembers}
          </Button>
          {expanded ? (
            // 横向流式列表：50 个名字约 3 行；failed 的名字后面带自己的 detail 原文
            <div className="mt-1 flex flex-wrap gap-1.5">
              {batch.capabilityKeys.map((capabilityKey) => (
                <span
                  key={capabilityKey}
                  data-testid="capability-history-batch-member"
                  data-capability-key={capabilityKey}
                  className="max-w-full break-words rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                >
                  {homogeneous
                    ? (splitCapabilityKey(capabilityKey)?.name ?? capabilityKey)
                    : capabilityDisplayName(capabilityKey, text)}
                  {batch.details[capabilityKey] ? (
                    <span className="text-zinc-500">{` — ${batch.details[capabilityKey]}`}</span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </>
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

  // 450 条量级的过滤+排序+聚簇，别每次 render 重算
  const history = useMemo(
    () => (read?.state === 'present'
      ? projectCapabilityLifecycleHistory(read.events)
      : { batches: [] as CapabilityLifecycleBatch[], unreadable: 0 }),
    [read],
  );

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

      {history.batches.length === 0 ? (
        // 有账本但读不出来时说实话，别和「还没有记录」长得一样
        <EmptyState
          variant="panel"
          title={text.emptyTitle}
          text={history.unreadable > 0
            ? text.emptyUnreadable.replace('{count}', String(history.unreadable))
            : text.emptyText}
        />
      ) : (
        <div className="space-y-2">
          {history.batches.map((batch) => (
            <BatchRow
              key={`${batch.action}-${batch.ts}-${batch.capabilityKeys.length}`}
              batch={batch}
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
