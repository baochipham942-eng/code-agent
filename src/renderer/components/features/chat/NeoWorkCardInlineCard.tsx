import React, { useCallback } from 'react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '@shared/contract/tag';
import { Archive, Brain, Check, CheckCircle2, RotateCcw, Sparkles, X } from 'lucide-react';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { useNeoWorkCardStore } from '../../../stores/neoWorkCardStore';

type NeoWorkCardInlineActionKind = 'approve' | 'reject' | 'cancel' | 'archive' | 'acceptResult' | 'requestChanges';

interface NeoWorkCardStatusAction {
  action: NeoWorkCardInlineActionKind;
  label: string;
  icon: React.ElementType;
}

const STATUS_LABELS: Record<NeoWorkCardStatus, string> = {
  draft: '草稿',
  needs_review: '待审',
  approved: '已批准',
  queued: '队列中',
  working: '运行中',
  waiting_for_user: '等用户',
  in_result_review: '结果待看',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  archived: '已归档',
};

const STATUS_STYLES: Record<NeoWorkCardStatus, string> = {
  draft: 'border-zinc-700 bg-zinc-800/70 text-zinc-300',
  needs_review: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  approved: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  queued: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  working: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  waiting_for_user: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  in_result_review: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200',
  completed: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  cancelled: 'border-zinc-700 bg-zinc-900 text-zinc-500',
  archived: 'border-zinc-800 bg-zinc-950 text-zinc-500',
};

export function getNeoWorkCardStatusActions(status: NeoWorkCardStatus): NeoWorkCardStatusAction[] {
  switch (status) {
    case 'draft':
      return [
        { action: 'approve', label: '批准', icon: Check },
        { action: 'reject', label: '退回修改', icon: RotateCcw },
        { action: 'cancel', label: '取消', icon: X },
      ];
    case 'needs_review':
      return [
        { action: 'approve', label: '批准', icon: Check },
        { action: 'reject', label: '退回修改', icon: RotateCcw },
        { action: 'cancel', label: '取消', icon: X },
      ];
    case 'approved':
      return [
        { action: 'cancel', label: '取消', icon: X },
      ];
    case 'in_result_review':
      return [
        { action: 'acceptResult', label: '接受结果', icon: CheckCircle2 },
        { action: 'requestChanges', label: '退回修改', icon: RotateCcw },
        { action: 'archive', label: '归档', icon: Archive },
      ];
    case 'failed':
    case 'completed':
    case 'cancelled':
      return [
        { action: 'archive', label: '归档', icon: Archive },
      ];
    default:
      return [];
  }
}

function formatModelIntent(detail: NeoWorkCardDetail): string {
  const modelIntent = detail.currentRevision?.modelIntent;
  if (!modelIntent || modelIntent.mode === 'inherit_current') return '继承当前配置';
  if (modelIntent.mode === 'adaptive_auto') return '自动';
  return `${modelIntent.provider}/${modelIntent.model}`;
}

function countSummary(count: number, emptyLabel: string, unit: string): string {
  return count > 0 ? `${count} ${unit}` : emptyLabel;
}

function parseContextAudit(decisions: string[] = []): string | null {
  const audit = decisions.find((item) => item.startsWith('Context audit: '));
  if (!audit) return null;
  const pairs = new Map<string, string>();
  for (const segment of audit.slice('Context audit: '.length).split(/\s+/)) {
    const splitAt = segment.indexOf('=');
    if (splitAt <= 0) continue;
    pairs.set(segment.slice(0, splitAt), segment.slice(splitAt + 1));
  }
  const pack = pairs.get('pack') ?? 'unknown';
  const tokens = pairs.get('tokens') ?? '0/0';
  const messages = Number(pairs.get('messages')) || 0;
  const artifacts = Number(pairs.get('artifacts')) || 0;
  const files = Number(pairs.get('files')) || 0;
  const memory = Number(pairs.get('memory')) || 0;
  const sources = pairs.get('sources') ?? 'none';
  const sourceLabel = sources === 'none' ? '无上下文来源' : sources;
  return `${pack} · ${messages} 消息 / ${artifacts} 产物 / ${files} 文件 / ${memory} 记忆 · ${tokens} tokens · ${sourceLabel}`;
}

export const NeoWorkCardInlineCard: React.FC<{ detail: NeoWorkCardDetail }> = ({ detail }) => {
  const actorUserId = useAuthStore((state) => state.user?.id ?? detail.workCard.requesterUserId);
  const pending = useNeoWorkCardStore((state) => Boolean(state.pendingStatusById[detail.workCard.id]));
  const approve = useNeoWorkCardStore((state) => state.approve);
  const reject = useNeoWorkCardStore((state) => state.reject);
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const acceptResult = useNeoWorkCardStore((state) => state.acceptResult);
  const requestChanges = useNeoWorkCardStore((state) => state.requestChanges);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);
  const latestDelta = detail.deltas.at(-1);
  const pendingMemoryCandidates = detail.memoryCandidates.filter((candidate) => candidate.status === 'pending');
  const revision = detail.currentRevision;
  const actions = getNeoWorkCardStatusActions(detail.workCard.status);
  const contextAudit = parseContextAudit(latestDelta?.decisions);

  const handleAction = useCallback(async (action: NeoWorkCardInlineActionKind) => {
    try {
      if (action === 'approve') {
        if (!revision?.id) throw new Error('Neo work card 缺少当前 revision');
        await approve({ workCardId: detail.workCard.id, actorUserId, revisionId: revision.id });
      } else if (action === 'reject') {
        if (!revision?.id) throw new Error('Neo work card 缺少当前 revision');
        await reject({ workCardId: detail.workCard.id, actorUserId, revisionId: revision.id });
      } else if (action === 'cancel') {
        await cancel({ workCardId: detail.workCard.id, actorUserId });
      } else if (action === 'archive') {
        await archive({ workCardId: detail.workCard.id, actorUserId });
      } else if (action === 'acceptResult') {
        await acceptResult({ workCardId: detail.workCard.id, actorUserId });
      } else if (action === 'requestChanges') {
        await requestChanges({
          workCardId: detail.workCard.id,
          actorUserId,
          feedback: '需要按结果复盘继续修改',
          openQuestions: latestDelta?.openQuestions ?? [],
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新 Neo work card 失败');
    }
  }, [acceptResult, actorUserId, approve, archive, cancel, detail.workCard.id, latestDelta?.openQuestions, reject, requestChanges, revision?.id]);

  const handleApproveMemory = useCallback(async (candidateId: string) => {
    try {
      await approveMemoryCandidate({ candidateId, actorUserId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准记忆失败');
    }
  }, [actorUserId, approveMemoryCandidate]);

  return (
    <div
      className="w-full max-w-3xl rounded-lg border border-emerald-400/25 bg-zinc-900/90 px-4 py-4 shadow-sm shadow-black/20 sm:px-5"
      data-testid="neo-work-card"
      data-density="expanded"
      data-work-card-id={detail.workCard.id}
      data-work-card-status={detail.workCard.status}
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-emerald-400/25 bg-emerald-400/10 text-emerald-200">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-200/80">Neo work card</div>
              <h3 className="mt-1 text-base font-semibold leading-6 text-zinc-100">{detail.workCard.title}</h3>
            </div>
            <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${STATUS_STYLES[detail.workCard.status] ?? STATUS_STYLES.draft}`}>
              {STATUS_LABELS[detail.workCard.status] ?? detail.workCard.status}
            </span>
          </div>
          {revision?.taskSummary && (
            <div
              className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-3"
              data-testid="neo-work-card-summary"
            >
              <div className="text-[11px] font-medium text-zinc-500">任务摘要</div>
              <p className="mt-1 text-sm leading-6 text-zinc-200">{revision.taskSummary}</p>
            </div>
          )}
          <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-3">
            <div className="rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2">
              <div className="text-[11px] text-zinc-600">读取范围</div>
              <div className="mt-0.5 text-zinc-300">{countSummary(revision?.readScope.messageIds.length ?? 0, '当前请求', '条消息')}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2">
              <div className="text-[11px] text-zinc-600">写入范围</div>
              <div className="mt-0.5 text-zinc-300">{revision?.writeScope.mode === 'none' ? '无写入' : '当前项目'}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2">
              <div className="text-[11px] text-zinc-600">模型</div>
              <div className="mt-0.5 truncate text-zinc-300">{formatModelIntent(detail)}</div>
            </div>
          </div>
          {revision?.risks.length ? (
            <div className="mt-3 rounded-md border border-amber-400/15 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-100/90">
              风险：{revision.risks.slice(0, 2).join('；')}
            </div>
          ) : null}
          {latestDelta && (
            <div
              className="mt-4 rounded-md border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-3 text-sm leading-6 text-zinc-300"
              data-testid="neo-work-card-delta"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-emerald-100">运行结果</div>
                {contextAudit && <div className="hidden text-[11px] text-zinc-500 sm:block">Context pack ready</div>}
              </div>
              <div className="grid gap-1.5">
                {latestDelta.completed.length > 0 && <div>结果：{latestDelta.completed.slice(0, 3).join('；')}</div>}
                {latestDelta.changedFiles.length > 0 && <div>改动：{latestDelta.changedFiles.slice(0, 3).join('；')}</div>}
                {contextAudit && (
                  <div
                    className="rounded-md border border-zinc-800 bg-zinc-950/45 px-2.5 py-2 text-xs leading-5 text-zinc-400"
                    data-testid="neo-work-card-context-audit"
                  >
                    上下文：{contextAudit}
                  </div>
                )}
                {latestDelta.risks.length > 0 && <div className="text-amber-100/90">风险：{latestDelta.risks.slice(0, 3).join('；')}</div>}
                {latestDelta.openQuestions.length > 0 && <div className="text-cyan-100/90">待确认：{latestDelta.openQuestions.slice(0, 3).join('；')}</div>}
              </div>
            </div>
          )}
          {detail.memoryCandidates.length > 0 && (
            <div className="mt-3 rounded-md border border-fuchsia-400/15 bg-fuchsia-400/5 px-3 py-3">
              <div className="text-xs font-medium text-fuchsia-100">
                记忆差异：{pendingMemoryCandidates.length} 待确认，{detail.memoryCandidates.filter((candidate) => candidate.status === 'written').length} 已写入
              </div>
              <div className="mt-1 grid gap-1">
                {detail.memoryCandidates.slice(0, 3).map((candidate) => (
                  <div key={candidate.id} className="flex min-w-0 items-center justify-between gap-2 text-xs text-zinc-400">
                    <span className="min-w-0 truncate">{candidate.text}</span>
                    {candidate.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() => handleApproveMemory(candidate.id)}
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-fuchsia-400/25 bg-fuchsia-400/10 px-1.5 text-[10px] text-fuchsia-100 hover:bg-fuchsia-400/15"
                        data-testid={`neo-work-card-approve-memory-${candidate.id}`}
                        title="批准写入项目记忆"
                      >
                        <Brain className="h-3 w-3" />
                        批准
                      </button>
                    ) : (
                      <span className="shrink-0 text-[10px] text-zinc-600">{candidate.status === 'written' ? '已写入' : '已忽略'}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {actions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.action}
                    type="button"
                    disabled={pending}
                    onClick={() => handleAction(action.action)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/80 px-2.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                    title={action.label}
                    data-testid={`neo-work-card-action-${action.action}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{pending ? '更新中' : action.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
