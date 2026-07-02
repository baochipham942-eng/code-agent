// ============================================================================
// Project Collaboration Rows - 面板的行/分区子组件与状态映射助手
// ============================================================================
// 从 ProjectCollaborationPanel.tsx 平移抽出（纯代码搬移，无行为变更）。

import React, { useState } from 'react';
import {
  Brain,
  Archive,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Edit3,
  Eye,
  GitPullRequestArrow,
  ListOrdered,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '@shared/contract/tag';
import {
  type ProjectCollaborationContextAudit,
  type ProjectCollaborationDecisionItem,
  type ProjectCollaborationMemoryCandidate,
  type ProjectCollaborationWorkCardRecord,
} from './projectCollaborationData';

const STATUS_LABEL: Record<NeoWorkCardStatus, string> = {
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

const STATUS_TONE: Record<NeoWorkCardStatus, string> = {
  draft: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
  needs_review: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  approved: 'border-violet-500/25 bg-violet-500/10 text-violet-200',
  queued: 'border-sky-500/25 bg-sky-500/10 text-sky-200',
  working: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
  waiting_for_user: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  in_result_review: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-200',
  completed: 'border-zinc-700 bg-zinc-900/70 text-zinc-300',
  failed: 'border-rose-500/25 bg-rose-500/10 text-rose-200',
  cancelled: 'border-zinc-700 bg-zinc-900/70 text-zinc-500',
  archived: 'border-zinc-800 bg-zinc-950 text-zinc-500',
};

export type ProjectCollaborationStatusFilter =
  | 'all'
  | 'review'
  | 'running'
  | 'result-review'
  | 'attention'
  | 'queue'
  | 'completed'
  | 'closed';

export const STATUS_FILTERS: Array<{ id: ProjectCollaborationStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'review', label: '待审' },
  { id: 'running', label: '运行中' },
  { id: 'result-review', label: '结果' },
  { id: 'attention', label: '需处理' },
  { id: 'queue', label: '队列' },
  { id: 'completed', label: '完成' },
  { id: 'closed', label: '关闭' },
];

export function recordFromDetail(detail: NeoWorkCardDetail): ProjectCollaborationWorkCardRecord | null {
  const revision = detail.currentRevision ?? detail.approvedRevision;
  if (!revision) return null;
  return {
    card: detail.workCard,
    revision,
    delta: detail.deltas.at(-1),
    memoryCandidates: detail.memoryCandidates,
  };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function detailFromRecord(record: ProjectCollaborationWorkCardRecord): NeoWorkCardDetail {
  return {
    workCard: record.card,
    currentRevision: record.revision,
    approvedRevision: record.card.approvedRevisionId === record.revision.id ? record.revision : null,
    revisions: [record.revision],
    approvals: [],
    deltas: record.delta ? [record.delta] : [],
    resultReviews: [],
    memoryCandidates: record.memoryCandidates ?? [],
  };
}

export function getDefaultSelectedWorkCardId(records: ProjectCollaborationWorkCardRecord[]): string | null {
  const statusPriority: NeoWorkCardStatus[] = [
    'in_result_review',
    'draft',
    'needs_review',
    'working',
    'waiting_for_user',
    'failed',
    'approved',
    'queued',
    'completed',
    'cancelled',
    'archived',
  ];
  for (const status of statusPriority) {
    const match = records.find((record) => record.card.status === status);
    if (match) return match.card.id;
  }
  return records[0]?.card.id ?? null;
}

export function matchesStatusFilter(status: NeoWorkCardStatus, filter: ProjectCollaborationStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'review') return status === 'draft' || status === 'needs_review';
  if (filter === 'running') return status === 'working' || status === 'waiting_for_user';
  if (filter === 'result-review') return status === 'in_result_review';
  if (filter === 'attention') return status === 'failed';
  if (filter === 'queue') return status === 'approved' || status === 'queued';
  if (filter === 'completed') return status === 'completed';
  return status === 'cancelled' || status === 'archived';
}

export function buildSearchText(record: ProjectCollaborationWorkCardRecord, detail?: NeoWorkCardDetail): string {
  const currentRevision = detail?.currentRevision ?? detail?.approvedRevision ?? record.revision;
  const parts = [
    record.card.id,
    record.card.title,
    record.card.status,
    record.card.requesterUserId,
    record.card.sourceConversationId,
    record.card.sourceTurnId,
    currentRevision?.intent,
    currentRevision?.taskSummary,
    ...(currentRevision?.expectedOutputs ?? []).flatMap((output) => [output.kind, output.title, output.description]),
    ...(currentRevision?.risks ?? []),
    ...(currentRevision?.assumptions ?? []),
    ...((detail?.revisions ?? [record.revision]).flatMap((revision) => [
      revision.intent,
      revision.taskSummary,
      ...revision.expectedOutputs.flatMap((output) => [output.kind, output.title, output.description]),
      ...revision.risks,
      ...revision.assumptions,
    ])),
    ...((detail?.approvals ?? []).flatMap((approval) => [
      approval.decision,
      approval.approvedByUserId,
      approval.feedback,
    ])),
    ...((detail?.deltas ?? (record.delta ? [record.delta] : [])).flatMap((delta) => [
      delta.runId,
      delta.nextStep,
      ...delta.completed,
      ...delta.changedFiles,
      ...delta.decisions,
      ...delta.openQuestions,
      ...delta.risks,
      ...delta.memoryCandidates,
    ])),
    ...((detail?.resultReviews ?? []).flatMap((review) => [
      review.decision,
      review.actorUserId,
      review.feedback,
      ...review.openQuestions,
    ])),
    ...((detail?.memoryCandidates ?? record.memoryCandidates ?? []).flatMap((candidate) => [
      candidate.kind,
      candidate.text,
      candidate.source,
      candidate.status,
    ])),
  ];
  return parts.filter((part): part is string => Boolean(part)).join('\n').toLowerCase();
}

function WorkCardRow({
  record,
  isSelected,
  onSelect,
  onAcceptResult,
  onRequestChanges,
  onArchive,
  onUpdateDraft,
  onApprove,
  onReject,
  onCancel,
}: {
  record: ProjectCollaborationWorkCardRecord;
  isSelected?: boolean;
  onSelect?: (workCardId: string) => void;
  onAcceptResult?: (workCardId: string) => void | Promise<void>;
  onRequestChanges?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onUpdateDraft?: (workCardId: string, title: string, taskSummary: string) => void | Promise<void>;
  onApprove?: (workCardId: string) => void | Promise<void>;
  onReject?: (workCardId: string) => void | Promise<void>;
  onCancel?: (workCardId: string) => void | Promise<void>;
}) {
  const { card, revision } = record;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftSummary, setDraftSummary] = useState(revision.taskSummary);
  const resultReviewActions = card.status === 'in_result_review';
  const canReview = card.status === 'draft' || card.status === 'needs_review';
  const canUpdateDraft = card.status === 'draft' || card.status === 'needs_review';
  const canArchiveTerminal = card.status === 'failed' || card.status === 'completed' || card.status === 'cancelled';
  const canCancel = !['failed', 'completed', 'cancelled', 'archived'].includes(card.status);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(card.id)}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(card.id);
        }
      }}
      className={`rounded-md border px-3 py-2 text-left outline-none transition-colors ${
        isSelected
          ? 'border-violet-500/45 bg-violet-500/10'
          : 'border-zinc-800 bg-zinc-950/45 hover:border-zinc-700'
      }`}
      data-testid={`project-collab-row-${card.id}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="grid gap-1.5">
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="h-7 rounded border border-zinc-700 bg-zinc-900 px-2 text-[12px] text-zinc-100 outline-none focus:border-violet-400"
                data-testid={`project-collab-title-input-${card.id}`}
              />
              <textarea
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                rows={3}
                className="resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] leading-5 text-zinc-200 outline-none focus:border-violet-400"
                data-testid={`project-collab-summary-input-${card.id}`}
              />
            </div>
          ) : (
            <>
              <div className="truncate text-[13px] font-medium text-zinc-100" title={card.title}>
                {card.title}
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-zinc-500">
                {revision.taskSummary}
              </div>
            </>
          )}
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[card.status]}`}>
          {STATUS_LABEL[card.status]}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-zinc-600">
        <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5">{revision.intent}</span>
        <span className="max-w-full truncate" title={`发起人 ${card.requesterUserId}`}>
          发起人 {card.requesterUserId}
        </span>
        <span>rev {revision.revisionNumber}</span>
        <span>{formatTime(card.updatedAt)}</span>
      </div>
      {record.delta && (
        <div className="mt-2 grid gap-1 text-[11px] leading-5 text-zinc-500">
          {record.delta.completed.length > 0 && <div>结果：{record.delta.completed.slice(0, 2).join('；')}</div>}
          {record.delta.changedFiles.length > 0 && <div>改动：{record.delta.changedFiles.slice(0, 2).join('；')}</div>}
          {record.delta.risks.length > 0 && <div className="text-amber-200/80">风险：{record.delta.risks.slice(0, 2).join('；')}</div>}
          {record.delta.openQuestions.length > 0 && <div className="text-cyan-200/80">问题：{record.delta.openQuestions.slice(0, 2).join('；')}</div>}
        </div>
      )}
      {(canUpdateDraft || canReview || canCancel || canArchiveTerminal) && !resultReviewActions && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {canUpdateDraft && (
            editing ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onUpdateDraft?.(card.id, draftTitle, draftSummary);
                    setEditing(false);
                  } catch {
                    // Parent handler already shows a toast; keep edit mode open.
                  }
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 text-[11px] text-violet-100 hover:bg-violet-500/15"
                data-testid={`project-collab-save-draft-${card.id}`}
                title="保存草稿修订"
              >
                <Save className="h-3.5 w-3.5" />
                保存草稿
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
                data-testid={`project-collab-edit-draft-${card.id}`}
                title="编辑草稿"
              >
                <Edit3 className="h-3.5 w-3.5" />
                编辑
              </button>
            )
          )}
          {canReview && (
            <>
              <button
                type="button"
                onClick={() => onApprove?.(card.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] text-emerald-100 hover:bg-emerald-500/15"
                data-testid={`project-collab-approve-${card.id}`}
                title="批准当前修订"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                批准
              </button>
              <button
                type="button"
                onClick={() => onReject?.(card.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 text-[11px] text-rose-100 hover:bg-rose-500/15"
                data-testid={`project-collab-reject-${card.id}`}
                title="拒绝当前修订"
              >
                <XCircle className="h-3.5 w-3.5" />
                拒绝
              </button>
            </>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => onCancel?.(card.id)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
              data-testid={`project-collab-cancel-${card.id}`}
              title="取消 work card"
            >
              <XCircle className="h-3.5 w-3.5" />
              取消
            </button>
          )}
          {canArchiveTerminal && (
            <button
              type="button"
              onClick={() => onArchive?.(card.id)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
              data-testid={`project-collab-archive-${card.id}`}
              title="归档终态 work card"
            >
              <Archive className="h-3.5 w-3.5" />
              归档
            </button>
          )}
        </div>
      )}
      {resultReviewActions && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onAcceptResult?.(card.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] text-emerald-100 hover:bg-emerald-500/15"
            data-testid={`project-collab-accept-${card.id}`}
            title="接受结果"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            接受
          </button>
          <button
            type="button"
            onClick={() => onRequestChanges?.(card.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-[11px] text-amber-100 hover:bg-amber-500/15"
            data-testid={`project-collab-request-changes-${card.id}`}
            title="退回修改"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            退回
          </button>
          <button
            type="button"
            onClick={() => onArchive?.(card.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
            data-testid={`project-collab-archive-${card.id}`}
            title="归档"
          >
            <Archive className="h-3.5 w-3.5" />
            归档
          </button>
        </div>
      )}
    </div>
  );
}

export function EmptySection({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-600">
      {label}
    </div>
  );
}

export function WorkCardSection({
  id,
  title,
  icon,
  records,
  emptyLabel,
  selectedWorkCardId,
  onSelectWorkCard,
  onAcceptResult,
  onRequestChanges,
  onArchive,
  onUpdateDraft,
  onApprove,
  onReject,
  onCancel,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  records: ProjectCollaborationWorkCardRecord[];
  emptyLabel: string;
  selectedWorkCardId?: string | null;
  onSelectWorkCard?: (workCardId: string) => void;
  onAcceptResult?: (workCardId: string) => void | Promise<void>;
  onRequestChanges?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onUpdateDraft?: (workCardId: string, title: string, taskSummary: string) => void | Promise<void>;
  onApprove?: (workCardId: string) => void | Promise<void>;
  onReject?: (workCardId: string) => void | Promise<void>;
  onCancel?: (workCardId: string) => void | Promise<void>;
}) {
  return (
    <section data-testid={`project-collab-section-${id}`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
          {icon}
          {title}
        </div>
        <span className="text-[10px] text-zinc-600">{records.length}</span>
      </div>
      {records.length > 0 ? (
        <div className="grid gap-1.5">
          {records.map((record) => (
            <WorkCardRow
              key={record.card.id}
              record={record}
              isSelected={selectedWorkCardId === record.card.id}
              onSelect={onSelectWorkCard}
              onAcceptResult={onAcceptResult}
              onRequestChanges={onRequestChanges}
              onArchive={onArchive}
              onUpdateDraft={onUpdateDraft}
              onApprove={onApprove}
              onReject={onReject}
              onCancel={onCancel}
            />
          ))}
        </div>
      ) : (
        <EmptySection label={emptyLabel} />
      )}
    </section>
  );
}

export function DecisionRow({ item }: { item: ProjectCollaborationDecisionItem }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-2">
      <div className="text-[12px] leading-5 text-zinc-200">{item.text}</div>
      <div className="mt-1 truncate text-[10px] text-zinc-600">{item.workCardTitle}</div>
    </div>
  );
}

export function MemoryCandidateRow({
  item,
  onApproveMemory,
  onRejectMemory,
}: {
  item: ProjectCollaborationMemoryCandidate;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
  onRejectMemory?: (candidateId: string) => void | Promise<void>;
}) {
  const pending = item.status === 'pending';
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-2">
      <div className="text-[12px] leading-5 text-zinc-200">{item.text}</div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-zinc-600">
        <span className="truncate">{item.workCardTitle}</span>
        <span className="rounded border border-zinc-800 px-1.5 py-0.5">{item.source === 'explicit_memory_plan' ? '显式计划' : '结果复盘'}</span>
        <span className="rounded border border-zinc-800 px-1.5 py-0.5">{item.status === 'written' ? '已写入' : item.status === 'rejected' ? '已忽略' : '待确认'}</span>
      </div>
      {pending && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onApproveMemory?.(item.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 text-[11px] text-fuchsia-100 hover:bg-fuchsia-500/15"
            data-testid={`project-collab-approve-memory-${item.id}`}
            title="批准写入项目记忆"
          >
            <Brain className="h-3.5 w-3.5" />
            批准记忆
          </button>
          <button
            type="button"
            onClick={() => onRejectMemory?.(item.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
            data-testid={`project-collab-reject-memory-${item.id}`}
            title="忽略记忆候选"
          >
            <XCircle className="h-3.5 w-3.5" />
            忽略
          </button>
        </div>
      )}
    </div>
  );
}

export function ContextAuditRow({ item }: { item: ProjectCollaborationContextAudit }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[12px] font-medium text-zinc-200">{item.workCardTitle}</div>
        <span className="shrink-0 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-500">
          {item.strategy}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-zinc-600">
        <span className="max-w-full truncate">pack {item.id}</span>
        <span>{item.selectedEvidenceCount} 证据</span>
        <span>{item.excludedCount} 排除</span>
        <span>{item.estimatedTokens}/{item.maxTokens} tokens</span>
        <span>{item.sourceTypes.length > 0 ? item.sourceTypes.join('+') : '无上下文来源'}</span>
      </div>
    </div>
  );
}

