/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
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
  Search,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '@shared/contract/tag';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import {
  ensureNeoWorkCardLiveUpdates,
  isNeoWorkCardAwaitingRuntimeTerminal,
  NEO_WORK_CARD_LIVE_REFRESH_MS,
  selectNeoWorkCardDetailsForProject,
  useNeoWorkCardStore,
} from '../../../stores/neoWorkCardStore';
import {
  buildProjectCollaborationGroups,
  type ProjectCollaborationContextAudit,
  type ProjectCollaborationDecisionItem,
  type ProjectCollaborationMemoryCandidate,
  type ProjectCollaborationWorkCardRecord,
} from './projectCollaborationData';
import { ProjectCollaborationDetailPane } from './ProjectCollaborationDetailPane';

export interface ProjectCollaborationPanelProps {
  projectId?: string | null;
  records?: ProjectCollaborationWorkCardRecord[];
  onUpdateDraft?: (workCardId: string, title: string, taskSummary: string) => void | Promise<void>;
  onApprove?: (workCardId: string) => void | Promise<void>;
  onReject?: (workCardId: string) => void | Promise<void>;
  onCancel?: (workCardId: string) => void | Promise<void>;
  onAcceptResult?: (workCardId: string) => void | Promise<void>;
  onRequestChanges?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
  onRejectMemory?: (candidateId: string) => void | Promise<void>;
}

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

type ProjectCollaborationStatusFilter =
  | 'all'
  | 'review'
  | 'running'
  | 'result-review'
  | 'attention'
  | 'queue'
  | 'completed'
  | 'closed';

const STATUS_FILTERS: Array<{ id: ProjectCollaborationStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'review', label: '待审' },
  { id: 'running', label: '运行中' },
  { id: 'result-review', label: '结果' },
  { id: 'attention', label: '需处理' },
  { id: 'queue', label: '队列' },
  { id: 'completed', label: '完成' },
  { id: 'closed', label: '关闭' },
];

function recordFromDetail(detail: NeoWorkCardDetail): ProjectCollaborationWorkCardRecord | null {
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

function detailFromRecord(record: ProjectCollaborationWorkCardRecord): NeoWorkCardDetail {
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

function getDefaultSelectedWorkCardId(records: ProjectCollaborationWorkCardRecord[]): string | null {
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

function matchesStatusFilter(status: NeoWorkCardStatus, filter: ProjectCollaborationStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'review') return status === 'draft' || status === 'needs_review';
  if (filter === 'running') return status === 'working' || status === 'waiting_for_user';
  if (filter === 'result-review') return status === 'in_result_review';
  if (filter === 'attention') return status === 'failed';
  if (filter === 'queue') return status === 'approved' || status === 'queued';
  if (filter === 'completed') return status === 'completed';
  return status === 'cancelled' || status === 'archived';
}

function buildSearchText(record: ProjectCollaborationWorkCardRecord, detail?: NeoWorkCardDetail): string {
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

function EmptySection({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-600">
      {label}
    </div>
  );
}

function WorkCardSection({
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

function DecisionRow({ item }: { item: ProjectCollaborationDecisionItem }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-2">
      <div className="text-[12px] leading-5 text-zinc-200">{item.text}</div>
      <div className="mt-1 truncate text-[10px] text-zinc-600">{item.workCardTitle}</div>
    </div>
  );
}

function MemoryCandidateRow({
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

function ContextAuditRow({ item }: { item: ProjectCollaborationContextAudit }) {
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

export const ProjectCollaborationPanel: React.FC<ProjectCollaborationPanelProps> = ({
  projectId = null,
  records,
  onUpdateDraft,
  onApprove,
  onReject,
  onCancel,
  onAcceptResult,
  onRequestChanges,
  onArchive,
  onApproveMemory,
  onRejectMemory,
}) => {
  const actorUserId = useAuthStore((state) => state.user?.id ?? 'local-user');
  const storeDetails = useNeoWorkCardStore(useShallow((state) => selectNeoWorkCardDetailsForProject(state, projectId)));
  const loading = useNeoWorkCardStore((state) => projectId ? Boolean(state.loadingProjectIds[projectId]) : false);
  const loadError = useNeoWorkCardStore((state) => projectId ? state.lastErrorByProjectId[projectId] ?? null : null);
  const loadForProject = useNeoWorkCardStore((state) => state.loadForProject);
  const updateDraftRevision = useNeoWorkCardStore((state) => state.updateDraftRevision);
  const approve = useNeoWorkCardStore((state) => state.approve);
  const reject = useNeoWorkCardStore((state) => state.reject);
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const acceptResult = useNeoWorkCardStore((state) => state.acceptResult);
  const requestChanges = useNeoWorkCardStore((state) => state.requestChanges);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);
  const rejectMemoryCandidate = useNeoWorkCardStore((state) => state.rejectMemoryCandidate);
  const derivedRecords = useMemo(
    () => storeDetails.map(recordFromDetail).filter((record): record is ProjectCollaborationWorkCardRecord => Boolean(record)),
    [storeDetails],
  );
  const panelRecords = records ?? derivedRecords;
  const [selectedWorkCardId, setSelectedWorkCardId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProjectCollaborationStatusFilter>('all');
  const [requesterFilter, setRequesterFilter] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const detailById = useMemo(() => {
    const map = new Map(storeDetails.map((detail) => [detail.workCard.id, detail]));
    for (const record of panelRecords) {
      if (!map.has(record.card.id)) map.set(record.card.id, detailFromRecord(record));
    }
    return map;
  }, [panelRecords, storeDetails]);
  const requesterOptions = useMemo(() => {
    return Array.from(new Set(panelRecords.map((record) => record.card.requesterUserId))).sort();
  }, [panelRecords]);
  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return panelRecords.filter((record) => {
      if (!matchesStatusFilter(record.card.status, statusFilter)) return false;
      if (requesterFilter !== 'all' && record.card.requesterUserId !== requesterFilter) return false;
      if (mineOnly && record.card.requesterUserId !== actorUserId) return false;
      if (query && !buildSearchText(record, detailById.get(record.card.id)).includes(query)) return false;
      return true;
    });
  }, [actorUserId, detailById, mineOnly, panelRecords, requesterFilter, searchQuery, statusFilter]);
  const groups = useMemo(() => buildProjectCollaborationGroups(filteredRecords), [filteredRecords]);
  const selectedDetail = selectedWorkCardId ? detailById.get(selectedWorkCardId) ?? null : null;
  useEffect(() => {
    ensureNeoWorkCardLiveUpdates();
  }, []);
  useEffect(() => {
    if (records !== undefined || !projectId) return;
    void loadForProject(projectId, { includeArchived: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : '加载 Neo work cards 失败');
    });
  }, [loadForProject, projectId, records]);
  const hasNeoWorkCardAwaitingRuntimeTerminal = storeDetails.some((detail) =>
    isNeoWorkCardAwaitingRuntimeTerminal(detail.workCard.status)
  );
  useEffect(() => {
    if (records !== undefined || !projectId || !hasNeoWorkCardAwaitingRuntimeTerminal) return;
    const interval = window.setInterval(() => {
      void loadForProject(projectId, { includeArchived: true }).catch((error) => {
        toast.error(error instanceof Error ? error.message : '刷新 Neo work cards 失败');
      });
    }, NEO_WORK_CARD_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [hasNeoWorkCardAwaitingRuntimeTerminal, loadForProject, projectId, records]);
  useEffect(() => {
    if (filteredRecords.length === 0) {
      if (selectedWorkCardId !== null) setSelectedWorkCardId(null);
      return;
    }
    if (!selectedWorkCardId || !filteredRecords.some((record) => record.card.id === selectedWorkCardId)) {
      setSelectedWorkCardId(getDefaultSelectedWorkCardId(filteredRecords));
    }
  }, [filteredRecords, selectedWorkCardId]);
  const handleUpdateDraft = useCallback(async (workCardId: string, title: string, taskSummary: string) => {
    try {
      if (onUpdateDraft) {
        await onUpdateDraft(workCardId, title, taskSummary);
        return;
      }
      const detail = detailById.get(workCardId);
      const revision = detail?.currentRevision ?? detail?.approvedRevision;
      if (!revision) throw new Error('Neo work card 缺少当前修订，无法保存草稿。');
      await updateDraftRevision({
        workCardId,
        updatedByUserId: actorUserId,
        title,
        revision: {
          intent: revision.intent,
          taskSummary,
          readScope: revision.readScope,
          writeScope: revision.writeScope,
          modelIntent: revision.modelIntent,
          memoryPlan: revision.memoryPlan,
          expectedOutputs: revision.expectedOutputs,
          risks: revision.risks,
          assumptions: revision.assumptions,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存 Neo work card 草稿失败');
      throw error;
    }
  }, [actorUserId, detailById, onUpdateDraft, updateDraftRevision]);
  const handleApprove = useCallback(async (workCardId: string) => {
    try {
      if (onApprove) {
        await onApprove(workCardId);
      } else {
        const detail = detailById.get(workCardId);
        await approve({ workCardId, actorUserId, revisionId: detail?.workCard.currentRevisionId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准 Neo work card 失败');
    }
  }, [actorUserId, approve, detailById, onApprove]);
  const handleReject = useCallback(async (workCardId: string) => {
    try {
      if (onReject) {
        await onReject(workCardId);
      } else {
        const detail = detailById.get(workCardId);
        await reject({ workCardId, actorUserId, revisionId: detail?.workCard.currentRevisionId, feedback: '退回修改' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '拒绝 Neo work card 失败');
    }
  }, [actorUserId, detailById, onReject, reject]);
  const handleCancel = useCallback(async (workCardId: string) => {
    try {
      if (onCancel) {
        await onCancel(workCardId);
      } else {
        await cancel({ workCardId, actorUserId, feedback: '用户取消' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消 Neo work card 失败');
    }
  }, [actorUserId, cancel, onCancel]);
  const handleAcceptResult = useCallback(async (workCardId: string) => {
    try {
      if (onAcceptResult) {
        await onAcceptResult(workCardId);
      } else {
        await acceptResult({ workCardId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接受 Neo work card 结果失败');
    }
  }, [acceptResult, actorUserId, onAcceptResult]);
  const handleRequestChanges = useCallback(async (workCardId: string) => {
    try {
      if (onRequestChanges) {
        await onRequestChanges(workCardId);
      } else {
        await requestChanges({ workCardId, actorUserId, feedback: '需要继续修改' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '退回 Neo work card 失败');
    }
  }, [actorUserId, onRequestChanges, requestChanges]);
  const handleArchive = useCallback(async (workCardId: string) => {
    try {
      if (onArchive) {
        await onArchive(workCardId);
      } else {
        await archive({ workCardId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档 Neo work card 失败');
    }
  }, [actorUserId, archive, onArchive]);
  const handleApproveMemory = useCallback(async (candidateId: string) => {
    try {
      if (onApproveMemory) {
        await onApproveMemory(candidateId);
      } else {
        await approveMemoryCandidate({ candidateId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准 Neo 记忆候选失败');
    }
  }, [actorUserId, approveMemoryCandidate, onApproveMemory]);
  const handleRejectMemory = useCallback(async (candidateId: string) => {
    try {
      if (onRejectMemory) {
        await onRejectMemory(candidateId);
      } else {
        await rejectMemoryCandidate({ candidateId, actorUserId, reason: '用户忽略' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '忽略 Neo 记忆候选失败');
    }
  }, [actorUserId, onRejectMemory, rejectMemoryCandidate]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-900">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-violet-500/20 bg-violet-500/10">
            <Sparkles className="h-4 w-4 text-violet-200" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Neo 项目合作</h2>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {projectId ? `Project work cards · ${projectId}` : 'Project work cards'}
            </div>
          </div>
        </div>
        {loading && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载 Neo work cards
          </div>
        )}
        {loadError && (
          <div
            className="mt-3 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] leading-5 text-rose-100"
            data-testid="project-collab-load-error"
          >
            {loadError}
          </div>
        )}
        {!projectId && records === undefined && (
          <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] leading-5 text-zinc-500">
            当前 web/browser 会话还没有项目绑定。浏览器模式不能打开系统目录选择器时，先使用当前工作区发起 @neo，或切到已经绑定项目的会话再看这里。
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <section data-testid="project-collab-section-overview" className="mb-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <ClipboardCheck className="h-3.5 w-3.5 text-zinc-500" />
                Overview
              </div>
              <span className="text-[10px] text-zinc-600">{filteredRecords.length}/{panelRecords.length}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
              {[
                ['全部', groups.overview.total, 'text-zinc-200'],
                ['待审', groups.overview.review, 'text-amber-200'],
                ['运行中', groups.overview.running, 'text-emerald-200'],
                ['结果待看', groups.overview.resultReview, 'text-cyan-200'],
                ['需处理', groups.overview.attention, 'text-rose-200'],
                ['队列', groups.overview.queue, 'text-sky-200'],
                ['已完成', groups.overview.completed, 'text-zinc-300'],
                ['已关闭', groups.overview.closed, 'text-zinc-500'],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-md border border-zinc-800 bg-zinc-950/45 px-2 py-2">
                  <div className="text-zinc-600">{label}</div>
                  <div className={`mt-0.5 text-sm font-semibold ${tone}`}>{value}</div>
                </div>
              ))}
            </div>
          </section>

          <section data-testid="project-collab-filters" className="mb-4 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/45 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索 title / summary / changedFiles"
                className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500/60"
                data-testid="project-collab-search"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setStatusFilter(filter.id)}
                  className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                    statusFilter === filter.id
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-100'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                  data-testid={`project-collab-status-filter-${filter.id}`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-[160px] flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
                发起人
                <select
                  value={requesterFilter}
                  onChange={(event) => setRequesterFilter(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-300 outline-none focus:border-violet-500/60"
                  data-testid="project-collab-requester-filter"
                >
                  <option value="all">全部</option>
                  {requesterOptions.map((requester) => (
                    <option key={requester} value={requester}>{requester}</option>
                  ))}
                </select>
              </label>
              <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(event) => setMineOnly(event.target.checked)}
                  className="h-3.5 w-3.5 accent-violet-500"
                  data-testid="project-collab-mine-filter"
                />
                只看我的
              </label>
            </div>
          </section>

          <div className="grid gap-4">
            <WorkCardSection
              id="review"
              title="待审"
              icon={<Clock3 className="h-3.5 w-3.5 text-amber-300" />}
              records={groups.review}
              emptyLabel="暂无待审 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
              onUpdateDraft={handleUpdateDraft}
              onApprove={handleApprove}
              onReject={handleReject}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="running"
              title="运行中"
              icon={<Loader2 className="h-3.5 w-3.5 text-emerald-300" />}
              records={groups.running}
              emptyLabel="暂无运行中的 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="result-review"
              title="结果待看"
              icon={<Eye className="h-3.5 w-3.5 text-cyan-300" />}
              records={groups.resultReview}
              emptyLabel="暂无结果待看"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onAcceptResult={handleAcceptResult}
              onRequestChanges={handleRequestChanges}
              onArchive={handleArchive}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="attention"
              title="需要处理"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-300" />}
              records={groups.attention}
              emptyLabel="暂无失败或阻塞的 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />
            <WorkCardSection
              id="completed"
              title="已完成"
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-zinc-400" />}
              records={groups.completed}
              emptyLabel="暂无已完成 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />
            <WorkCardSection
              id="closed"
              title="已关闭"
              icon={<Archive className="h-3.5 w-3.5 text-zinc-500" />}
              records={groups.closed}
              emptyLabel="暂无已关闭 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />

            <section data-testid="project-collab-section-decisions" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <GitPullRequestArrow className="h-3.5 w-3.5 text-violet-300" />
                  决策
                </div>
                <span className="text-[10px] text-zinc-600">{groups.decisions.length}</span>
              </div>
              {groups.decisions.length > 0
                ? <div className="grid gap-1.5">{groups.decisions.map((item) => <DecisionRow key={item.id} item={item} />)}</div>
                : <EmptySection label="暂无项目决策" />}
            </section>

            <section data-testid="project-collab-section-memory" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <Brain className="h-3.5 w-3.5 text-fuchsia-300" />
                  记忆候选
                </div>
                <span className="text-[10px] text-zinc-600">{groups.memoryCandidates.length}</span>
              </div>
              {groups.memoryCandidates.length > 0
                ? (
                  <div className="grid gap-1.5">
                    {groups.memoryCandidates.map((item) => (
                      <MemoryCandidateRow
                        key={item.id}
                        item={item}
                        onApproveMemory={handleApproveMemory}
                        onRejectMemory={handleRejectMemory}
                      />
                    ))}
                  </div>
                )
                : <EmptySection label="暂无记忆候选" />}
            </section>

            <section data-testid="project-collab-section-context-audit" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-300" />
                  上下文审计
                </div>
                <span className="text-[10px] text-zinc-600">{groups.contextAudits.length}</span>
              </div>
              {groups.contextAudits.length > 0
                ? <div className="grid gap-1.5">{groups.contextAudits.map((item) => <ContextAuditRow key={item.id} item={item} />)}</div>
                : <EmptySection label="暂无上下文审计" />}
            </section>

            <WorkCardSection
              id="queue"
              title="队列"
              icon={<ListOrdered className="h-3.5 w-3.5 text-sky-300" />}
              records={groups.queue}
              emptyLabel="暂无排队 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onCancel={handleCancel}
            />
          </div>
        </div>

        <ProjectCollaborationDetailPane
          detail={selectedDetail}
          onApprove={handleApprove}
          onReject={handleReject}
          onCancel={handleCancel}
          onAcceptResult={handleAcceptResult}
          onRequestChanges={handleRequestChanges}
          onArchive={handleArchive}
          onApproveMemory={handleApproveMemory}
          onRejectMemory={handleRejectMemory}
        />
      </div>
    </div>
  );
};

export default ProjectCollaborationPanel;
