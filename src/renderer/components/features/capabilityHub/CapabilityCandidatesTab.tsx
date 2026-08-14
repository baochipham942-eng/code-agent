// ============================================================================
// 候选能力（N-CAP1 / F12）—— 能力中心第 5 个 tab
// ============================================================================
// 三条产品硬约束，改这个文件前先读一遍：
//   1. 零打断：这一屏**只有拉式**——没有事件订阅、没有轮询、没有红点、没有气泡。
//      数据只在挂载与用户点刷新时拉一次。
//   2. 不是待办队列：低分默认折叠、久未复现自动下沉（分数在 host 侧按时间衰减）。
//      本仓有过 skill-drafts 27 条堆积一个月只处置 2 条的实证——堆积之所以有害，
//      正因为它被做成了「待处理队列」。所以这里是排行榜，不是收件箱。
//   3. 文案只出现「能力」：插件 / plugin / manifest / 意图簇 一个都不许进 UI。
//
// 排序完全来自 host 的机械分；模型只出名字和一句说明，不参与排序。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  CapabilityCandidateList,
  CapabilityCandidateTier,
  CapabilityCandidateView,
} from '../../../../shared/contract/capabilityCandidate';
import { CAPABILITY_CANDIDATE_CHANNELS } from '../../../../shared/ipc/channels';
import ipcService from '../../../services/ipcService';
import { toast } from '../../../hooks/useToast';
import { useI18n } from '../../../hooks/useI18n';
import { Badge } from '../../primitives/Badge';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { HubTabHeader } from './HubTabHeader';

const invokeCandidate = async <T,>(channel: string, payload?: unknown): Promise<T | undefined> =>
  (ipcService.invoke as (...a: unknown[]) => Promise<T>)(channel, payload);

const DAY_MS = 24 * 60 * 60 * 1000;

type CandidateText = ReturnType<typeof useI18n>['t']['capabilityCandidates'];

function tierLabel(tier: CapabilityCandidateTier, text: CandidateText): string {
  if (tier === 'plugin') return text.tierPlugin;
  if (tier === 'workflow') return text.tierWorkflow;
  return text.tierSkill;
}

function tierHint(tier: CapabilityCandidateTier, text: CandidateText): string {
  if (tier === 'plugin') return text.tierPluginHint;
  if (tier === 'workflow') return text.tierWorkflowHint;
  return text.tierSkillHint;
}

function tierTone(tier: CapabilityCandidateTier): string {
  if (tier === 'plugin') return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  if (tier === 'workflow') return 'border-sky-500/40 bg-sky-500/10 text-sky-300';
  return 'border-zinc-600/60 bg-zinc-700/30 text-zinc-300';
}

function evidenceLine(candidate: CapabilityCandidateView, text: CandidateText): string {
  const days = Math.max(1, Math.round((Date.now() - candidate.firstSeenAt) / DAY_MS));
  const template = candidate.avgTokens > 0 ? text.evidence : text.evidenceNoTokens;
  return template
    .replace('{count}', String(candidate.occurrences))
    .replace('{days}', String(days))
    .replace('{steps}', String(Math.round(candidate.avgSteps)))
    .replace('{tokens}', text.tokensSuffix.replace('{tokens}', String(Math.round(candidate.avgTokens))));
}

interface CandidateRowProps {
  candidate: CapabilityCandidateView;
  text: CandidateText;
  busy: boolean;
  onIgnore: (clusterKey: string) => void;
  onDismiss: (clusterKey: string) => void;
}

const CandidateRow: React.FC<CandidateRowProps> = ({ candidate, text, busy, onIgnore, onDismiss }) => (
  <li
    data-testid="capability-candidate-row"
    data-cluster-key={candidate.clusterKey}
    className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
  >
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">
            {candidate.displayName || candidate.shapeTokens.join(' + ')}
          </span>
          <Badge className={`shrink-0 text-[10px] font-medium ${tierTone(candidate.tier)}`} title={tierHint(candidate.tier, text)}>
            {tierLabel(candidate.tier, text)}
          </Badge>
        </div>
        {candidate.summary ? (
          <p className="mt-0.5 truncate text-xs text-zinc-400">{candidate.summary}</p>
        ) : null}
        <p className="mt-1 text-xs text-zinc-500">{evidenceLine(candidate, text)}</p>
        {/* 「凭什么把这几次归成一条」——聚类必须能解释，不能只给个分数 */}
        <p className="mt-0.5 text-[11px] text-zinc-600">
          {text.whyGrouped
            .replace('{count}', String(candidate.occurrences))
            .replace('{tokens}', candidate.shapeTokens.join(', '))
            .replace('{variants}', String(candidate.variants.length))}
        </p>
        {(candidate.signals.degraded || candidate.signals.missingDependency) ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {candidate.signals.degraded ? (
              <Badge className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">{text.degraded}</Badge>
            ) : null}
            {candidate.signals.missingDependency ? (
              <Badge className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">{text.missing}</Badge>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* 本期唯一置灰项：起草链路 P1b 才接，现在按下去什么都不该发生 */}
        <Button size="sm" variant="secondary" disabled title={text.actionBuildDisabled}>
          {text.actionBuild}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onIgnore(candidate.clusterKey)}>
          {text.actionIgnore}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(candidate.clusterKey)}>
          {text.actionDismiss}
        </Button>
      </div>
    </div>
  </li>
);

export const CapabilityCandidatesTab: React.FC = () => {
  const { t } = useI18n();
  const text = t.capabilityCandidates;
  const [list, setList] = useState<CapabilityCandidateList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [foldedOpen, setFoldedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invokeCandidate<CapabilityCandidateList>(CAPABILITY_CANDIDATE_CHANNELS.LIST);
      setList(result ?? { candidates: [], foldedCount: 0 });
    } catch {
      setList({ candidates: [], foldedCount: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  // 只在进这一屏时拉一次；没有订阅、没有定时器——列表是拉式的。
  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (
    clusterKey: string,
    channel: string,
    successMessage: string,
  ) => {
    setBusyKey(clusterKey);
    try {
      await invokeCandidate<{ success: boolean }>(channel, { clusterKey });
      toast.success(successMessage);
      await load();
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const onIgnore = useCallback((clusterKey: string) => {
    void act(clusterKey, CAPABILITY_CANDIDATE_CHANNELS.IGNORE, text.ignoredToast);
  }, [act, text.ignoredToast]);

  const onDismiss = useCallback((clusterKey: string) => {
    void act(clusterKey, CAPABILITY_CANDIDATE_CHANNELS.DISMISS, text.dismissedToast);
  }, [act, text.dismissedToast]);

  const { visible, folded } = useMemo(() => ({
    visible: (list?.candidates ?? []).filter((candidate) => candidate.aboveFold),
    folded: (list?.candidates ?? []).filter((candidate) => !candidate.aboveFold),
  }), [list]);

  return (
    <div data-testid="capability-candidates-tab">
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

      {visible.length === 0 && folded.length === 0 ? (
        <EmptyState variant="panel" title={text.emptyTitle} text={text.emptyText} />
      ) : (
        <ul className="space-y-2">
          {visible.map((candidate) => (
            <CandidateRow
              key={candidate.clusterKey}
              candidate={candidate}
              text={text}
              busy={busyKey === candidate.clusterKey}
              onIgnore={onIgnore}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      )}

      {folded.length > 0 ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFoldedOpen((open) => !open)}
            data-testid="capability-candidates-fold-toggle"
          >
            {foldedOpen ? text.hideFolded : text.showFolded.replace('{count}', String(folded.length))}
          </Button>
          {foldedOpen ? (
            <ul className="mt-2 space-y-2 opacity-70">
              {folded.map((candidate) => (
                <CandidateRow
                  key={candidate.clusterKey}
                  candidate={candidate}
                  text={text}
                  busy={busyKey === candidate.clusterKey}
                  onIgnore={onIgnore}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
