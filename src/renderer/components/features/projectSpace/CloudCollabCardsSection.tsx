// ============================================================================
// CloudCollabCardsSection —— C1：协作空间「任务」tab 的云端成员卡只读区。
// 数据源 = project 域 listCloudCards：其他成员共享上云的卡元数据（host 已剔除
// 本机卡，readonly 恒 true）。与下方本地 topic 列表（ProjectCollaborationPanel，
// 可取消/归档/审批）严格区分：本区卡片无任何编辑动作——不可点、无详情抽屉、
// 无取消/归档按钮；唯一动作是「重新同步本机卡」（project 域 resyncCloudCards，
// 把本机卡元数据重新推送上云，不改变本区列表内容）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, Loader2, Lock, RefreshCw } from 'lucide-react';
import type { CloudCollabCard } from '@shared/contract/project';
import type { NeoWorkCardStatus } from '@shared/contract/tag';
import { listCloudCards, resyncCloudCards } from '../../../services/projectClient';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { SecondaryButton } from '../../primitives/Button';
import {
  formatNeoTopicDueDay,
  formatRequesterLabel,
  isNeoTopicDueOverdue,
  NEO_WORK_CARD_PRIORITY_CHIP_STYLE,
} from '../projectCollaboration/projectCollaborationData';
import {
  NEO_WORK_CARD_PHASE_CHIP_STYLE,
  NEO_WORK_CARD_PHASE_LABEL,
  statusPhase,
} from '../chat/neoWorkCardPhase';

export interface CloudCollabCardsSectionProps {
  projectId: string;
}

type LoadState = 'loading' | 'ready' | 'error';

function CloudCardRow({ card }: { card: CloudCollabCard }) {
  const { t } = useI18n();
  const currentUser = useAuthStore((state) => state.user ?? null);
  // 云卡 status/priority 是白名单元数据（string），复用本地卡的相位/优先级视觉映射；
  // 未知值落 statusPhase 默认分支，不会炸
  const phase = statusPhase(card.status as NeoWorkCardStatus);
  const priority = (card.priority || 'medium') as 'urgent' | 'high' | 'medium' | 'low';
  const priorityLabel: Record<'urgent' | 'high' | 'low', string> = {
    urgent: t.neoTopics.priorityUrgent,
    high: t.neoTopics.priorityHigh,
    low: t.neoTopics.priorityLow,
  };
  const dueOverdue = isNeoTopicDueOverdue({ dueAt: card.dueAt, status: card.status as NeoWorkCardStatus });
  return (
    // 只读行：无 onClick/role=button，无任何动作 affordance（与本地 topic 行的区分点）
    <div
      className="rounded-md border border-zinc-800/80 bg-zinc-950/30 px-3 py-2"
      data-testid={`cloud-collab-card-${card.localCardId}`}
      data-readonly="true"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Lock className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
          <div className="min-w-0 truncate text-[13px] font-medium text-zinc-300" title={card.title}>
            {card.title}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {priority !== 'medium' && (
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${NEO_WORK_CARD_PRIORITY_CHIP_STYLE[priority]}`}
              data-testid={`cloud-collab-priority-${card.localCardId}`}
            >
              {priorityLabel[priority]}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${NEO_WORK_CARD_PHASE_CHIP_STYLE[phase]}`}>
            {NEO_WORK_CARD_PHASE_LABEL[phase]}
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-600">
        <span className="truncate">{formatRequesterLabel(card.requesterUserId, currentUser)}</span>
        <span>{new Date(card.updatedAt).toLocaleString()}</span>
        {card.dueAt != null && (
          <span
            className={dueOverdue ? 'font-medium text-rose-300' : undefined}
            data-testid={`cloud-collab-due-${card.localCardId}`}
          >
            {t.neoTopics.duePrefix} {formatNeoTopicDueDay(card.dueAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export const CloudCollabCardsSection: React.FC<CloudCollabCardsSectionProps> = ({ projectId }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [cards, setCards] = useState<CloudCollabCard[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resyncBusy, setResyncBusy] = useState(false);
  const [resyncFeedback, setResyncFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    listCloudCards(projectId)
      .then((rows) => {
        if (cancelled) return;
        setCards(rows);
        setLoadState('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadState('error');
      });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => load(), [load]);

  const handleResync = async () => {
    if (resyncBusy) return;
    setResyncBusy(true);
    setResyncFeedback(null);
    try {
      const report = await resyncCloudCards(projectId);
      setResyncFeedback({
        kind: 'success',
        text: ps.cloudCardsResyncSuccess
          .replace('{synced}', String(report.synced))
          .replace('{failed}', String(report.failed)),
      });
    } catch (error) {
      setResyncFeedback({
        kind: 'error',
        text: `${ps.cloudCardsResyncFailed}：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setResyncBusy(false);
    }
  };

  return (
    <section
      className="shrink-0 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-3 py-2.5"
      data-testid="cloud-collab-cards-section"
      aria-label={ps.cloudCardsTitle}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-zinc-400">
          <Cloud className="h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden />
          <span className="font-medium text-zinc-300">{ps.cloudCardsTitle}</span>
          <span
            className="inline-flex items-center rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300"
            data-testid="cloud-collab-readonly-badge"
          >
            {ps.cloudCardsReadonlyBadge}
          </span>
          {loadState === 'ready' && <span className="text-zinc-600">{cards.length}</span>}
        </div>
        <SecondaryButton
          size="sm"
          leftIcon={<RefreshCw className={`h-3 w-3 ${resyncBusy ? 'animate-spin' : ''}`} />}
          disabled={resyncBusy}
          data-testid="cloud-collab-resync"
          onClick={() => { void handleResync(); }}
        >
          {resyncBusy ? ps.cloudCardsResyncing : ps.cloudCardsResync}
        </SecondaryButton>
      </div>

      {resyncFeedback && (
        <div
          className={`mt-2 rounded border px-2 py-1 text-[11px] leading-5 ${
            resyncFeedback.kind === 'success'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
              : 'border-rose-500/25 bg-rose-500/10 text-rose-100'
          }`}
          data-testid={`cloud-collab-resync-${resyncFeedback.kind}`}
          role={resyncFeedback.kind === 'error' ? 'alert' : 'status'}
        >
          {resyncFeedback.text}
        </div>
      )}

      <div className="mt-2">
        {loadState === 'loading' && (
          <div className="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400" data-testid="cloud-collab-loading">
            <Loader2 className="h-3 w-3 animate-spin" />
            {ps.cloudCardsLoading}
          </div>
        )}
        {loadState === 'error' && (
          <div className="flex items-center justify-between gap-2 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] leading-5 text-rose-100" data-testid="cloud-collab-load-error">
            <span className="min-w-0">{ps.cloudCardsLoadFailed}：{loadError}</span>
            <button /* ds-allow:button: 云卡加载失败区的内联重试，rose 警示语境无对应 Button 变体 */
              type="button"
              className="shrink-0 rounded border border-rose-400/30 px-1.5 py-0.5 text-[10px] text-rose-200 hover:bg-rose-500/15"
              data-testid="cloud-collab-retry"
              onClick={() => load()}
            >
              {ps.cloudCardsRetry}
            </button>
          </div>
        )}
        {loadState === 'ready' && cards.length === 0 && (
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-3 py-3 text-center text-[11px] text-zinc-600" data-testid="cloud-collab-empty">
            {ps.cloudCardsEmpty}
          </div>
        )}
        {loadState === 'ready' && cards.length > 0 && (
          <div className="grid gap-1.5" data-testid="cloud-collab-list">
            {cards.map((card) => <CloudCardRow key={card.localCardId} card={card} />)}
          </div>
        )}
      </div>
    </section>
  );
};

export default CloudCollabCardsSection;
