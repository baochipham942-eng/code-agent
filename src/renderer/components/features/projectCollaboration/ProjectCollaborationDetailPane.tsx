import React from 'react';
import {
  Archive,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  GitPullRequestArrow,
  History,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type {
  NeoMemoryCandidate,
  NeoReadScope,
  NeoWorkCardDetail,
  NeoWorkCardStatus,
  NeoWriteScope,
} from '@shared/contract/tag';

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

function formatTime(timestamp?: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '无';
}

function boolLabel(value: boolean): string {
  return value ? '允许' : '不允许';
}

const Section: React.FC<{
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}> = ({ title, icon, children, testId }) => (
  <section data-testid={testId} className="rounded-md border border-zinc-800 bg-zinc-950/45">
    <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
      <div className="text-zinc-500">{icon}</div>
      <h3 className="text-xs font-medium text-zinc-200">{title}</h3>
    </div>
    <div className="p-3">{children}</div>
  </section>
);

const EmptyLine: React.FC<{ label: string }> = ({ label }) => (
  <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-600">
    {label}
  </div>
);

const ListBlock: React.FC<{ items?: string[]; empty: string }> = ({ items = [], empty }) => {
  const visible = items.filter((item) => item.trim().length > 0);
  if (visible.length === 0) return <EmptyLine label={empty} />;
  return (
    <ul className="grid gap-1">
      {visible.map((item, index) => (
        <li key={`${item}-${index}`} className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] leading-5 text-zinc-300">
          {item}
        </li>
      ))}
    </ul>
  );
};

function ScopeAudit({ readScope, writeScope }: { readScope?: NeoReadScope; writeScope?: NeoWriteScope }) {
  if (!readScope && !writeScope) return <EmptyLine label="暂无 scope 信息" />;
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {readScope && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-zinc-300">Read scope · {readScope.mode}</div>
          <ListBlock items={readScope.conversationIds} empty="无 conversation 限定" />
          <ListBlock items={readScope.messageIds} empty="无 message 限定" />
          <ListBlock items={readScope.artifactIds} empty="无 artifact 限定" />
          <ListBlock items={readScope.fileGlobs} empty="无文件读取范围" />
          <ListBlock items={readScope.memoryEntryIds} empty="无记忆条目限定" />
          <ListBlock items={readScope.notes} empty="无 read scope 备注" />
        </div>
      )}
      {writeScope && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-zinc-300">Write scope · {writeScope.mode}</div>
          <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] text-zinc-500">
            <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
              创建<br /><span className="text-zinc-300">{boolLabel(writeScope.canCreateFiles)}</span>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
              修改<br /><span className="text-zinc-300">{boolLabel(writeScope.canModifyFiles)}</span>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
              记忆<br /><span className="text-zinc-300">{boolLabel(writeScope.canWriteProjectMemory)}</span>
            </div>
          </div>
          <ListBlock items={writeScope.allowedPaths} empty="无写入路径" />
          <ListBlock items={writeScope.externalDestinations} empty="无外部目的地" />
          <ListBlock items={writeScope.notes} empty="无 write scope 备注" />
        </div>
      )}
    </div>
  );
}

function MemoryCandidateRows({
  candidates,
  onApproveMemory,
  onRejectMemory,
}: {
  candidates: NeoMemoryCandidate[];
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
  onRejectMemory?: (candidateId: string) => void | Promise<void>;
}) {
  if (candidates.length === 0) return <EmptyLine label="暂无记忆候选" />;
  return (
    <div className="grid gap-2">
      {candidates.map((candidate) => (
        <div key={candidate.id} className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
          <div className="text-[12px] leading-5 text-zinc-200">{candidate.text}</div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-zinc-600">
            <span>{candidate.kind}</span>
            <span>{candidate.source}</span>
            <span>{candidate.status}</span>
            <span>{formatTime(candidate.createdAt)}</span>
          </div>
          {candidate.status === 'pending' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onApproveMemory?.(candidate.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 text-[11px] text-fuchsia-100 hover:bg-fuchsia-500/15"
                data-testid={`project-collab-detail-approve-memory-${candidate.id}`}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                批准记忆
              </button>
              <button
                type="button"
                onClick={() => onRejectMemory?.(candidate.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
                data-testid={`project-collab-detail-reject-memory-${candidate.id}`}
              >
                <XCircle className="h-3.5 w-3.5" />
                忽略
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export interface ProjectCollaborationDetailPaneProps {
  detail: NeoWorkCardDetail | null;
  onApprove?: (workCardId: string) => void | Promise<void>;
  onReject?: (workCardId: string) => void | Promise<void>;
  onCancel?: (workCardId: string) => void | Promise<void>;
  onAcceptResult?: (workCardId: string) => void | Promise<void>;
  onRequestChanges?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
  onRejectMemory?: (candidateId: string) => void | Promise<void>;
}

export const ProjectCollaborationDetailPane: React.FC<ProjectCollaborationDetailPaneProps> = ({
  detail,
  onApprove,
  onReject,
  onCancel,
  onAcceptResult,
  onRequestChanges,
  onArchive,
  onApproveMemory,
  onRejectMemory,
}) => {
  if (!detail) {
    return (
      <div data-testid="project-collab-detail-empty" className="flex h-full items-center justify-center rounded-md border border-zinc-800 bg-zinc-950/45 p-6 text-sm text-zinc-500">
        选择一个 work card 查看完整任务记录
      </div>
    );
  }

  const { workCard } = detail;
  const currentRevision = detail.currentRevision ?? detail.approvedRevision;
  const canReview = workCard.status === 'draft' || workCard.status === 'needs_review';
  const canResultReview = workCard.status === 'in_result_review';
  const canCancel = !['failed', 'completed', 'cancelled', 'archived'].includes(workCard.status);
  const canArchive = ['failed', 'completed', 'cancelled', 'in_result_review'].includes(workCard.status);
  const revisions = detail.revisions.length > 0
    ? detail.revisions
    : currentRevision
      ? [currentRevision]
      : [];

  return (
    <aside data-testid="project-collab-detail-pane" className="h-full overflow-y-auto border-l border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-950/55 px-3 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100" title={workCard.title}>
              {workCard.title}
            </h2>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-zinc-600">
              <span className={`rounded border px-1.5 py-0.5 font-medium ${STATUS_TONE[workCard.status]}`}>
                {STATUS_LABEL[workCard.status]}
              </span>
              <span>发起人 {workCard.requesterUserId}</span>
              <span>来源 {workCard.sourceConversationId}</span>
              <span>{workCard.sourceTurnId}</span>
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] text-zinc-600">
          <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">创建 {formatTime(workCard.createdAt)}</div>
          <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1">更新 {formatTime(workCard.updatedAt)}</div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {canReview && (
          <>
            <button
              type="button"
              onClick={() => onApprove?.(workCard.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] text-emerald-100 hover:bg-emerald-500/15"
              data-testid={`project-collab-detail-approve-${workCard.id}`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              批准
            </button>
            <button
              type="button"
              onClick={() => onReject?.(workCard.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 text-[11px] text-rose-100 hover:bg-rose-500/15"
              data-testid={`project-collab-detail-reject-${workCard.id}`}
            >
              <XCircle className="h-3.5 w-3.5" />
              拒绝
            </button>
          </>
        )}
        {canResultReview && (
          <>
            <button
              type="button"
              onClick={() => onAcceptResult?.(workCard.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] text-emerald-100 hover:bg-emerald-500/15"
              data-testid={`project-collab-detail-accept-${workCard.id}`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              接受
            </button>
            <button
              type="button"
              onClick={() => onRequestChanges?.(workCard.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-[11px] text-amber-100 hover:bg-amber-500/15"
              data-testid={`project-collab-detail-request-changes-${workCard.id}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              退回
            </button>
          </>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={() => onCancel?.(workCard.id)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
            data-testid={`project-collab-detail-cancel-${workCard.id}`}
          >
            <XCircle className="h-3.5 w-3.5" />
            取消
          </button>
        )}
        {canArchive && (
          <button
            type="button"
            onClick={() => onArchive?.(workCard.id)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-600"
            data-testid={`project-collab-detail-archive-${workCard.id}`}
          >
            <Archive className="h-3.5 w-3.5" />
            归档
          </button>
        )}
      </div>

      <div className="grid gap-3">
        <Section title="当前任务" icon={<ClipboardCheck className="h-3.5 w-3.5" />} testId="project-collab-detail-current-task">
          {currentRevision ? (
            <div className="grid gap-2 text-[11px] leading-5 text-zinc-300">
              <div><span className="text-zinc-500">intent:</span> {currentRevision.intent}</div>
              <div>{currentRevision.taskSummary}</div>
              <ListBlock items={currentRevision.expectedOutputs.map((output) => `${output.kind}: ${output.title}${output.description ? ` · ${output.description}` : ''}`)} empty="无 expected output" />
              <ListBlock items={currentRevision.risks} empty="无风险记录" />
              <ListBlock items={currentRevision.assumptions} empty="无假设记录" />
            </div>
          ) : <EmptyLine label="暂无当前修订" />}
        </Section>

        <Section title="时间线" icon={<History className="h-3.5 w-3.5" />} testId="project-collab-detail-timeline">
          <div className="grid gap-2">
            {revisions.map((revision) => (
              <div key={revision.id} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
                <div className="text-[11px] font-medium text-zinc-300">revision #{revision.revisionNumber} · {revision.intent}</div>
                <div className="mt-1 text-[11px] leading-5 text-zinc-500">{revision.taskSummary}</div>
              </div>
            ))}
            {detail.approvals.map((approval) => (
              <div key={approval.id} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
                <div className="text-[11px] font-medium text-zinc-300">{approval.decision} by {approval.approvedByUserId}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{formatTime(approval.createdAt)} {approval.feedback ? `· ${approval.feedback}` : ''}</div>
              </div>
            ))}
            {detail.deltas.map((delta) => (
              <div key={delta.id} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
                <div className="text-[11px] font-medium text-zinc-300">delta {delta.runId}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{formatTime(delta.createdAt)}</div>
                <ListBlock items={delta.completed} empty="无 completed" />
                <ListBlock items={delta.changedFiles} empty="无 changed files" />
                <ListBlock items={delta.decisions} empty="无 decisions" />
                <ListBlock items={delta.openQuestions} empty="无 open questions" />
                <ListBlock items={delta.risks} empty="无 risks" />
                {delta.nextStep && <div className="mt-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-300">next: {delta.nextStep}</div>}
              </div>
            ))}
            {revisions.length === 0 && detail.approvals.length === 0 && detail.deltas.length === 0 && (
              <EmptyLine label="暂无时间线记录" />
            )}
          </div>
        </Section>

        <Section title="记录详情" icon={<FileText className="h-3.5 w-3.5" />} testId="project-collab-detail-records">
          <div className="grid gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium text-zinc-300">修订历史</div>
              <ListBlock items={revisions.map((revision) => `rev ${revision.revisionNumber}: ${revision.taskSummary}`)} empty="暂无修订历史" />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-zinc-300">审批记录</div>
              <ListBlock items={detail.approvals.map((approval) => `${approval.decision} · ${approval.approvedByUserId} · ${formatTime(approval.createdAt)}${approval.feedback ? ` · ${approval.feedback}` : ''}`)} empty="暂无审批记录" />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-zinc-300">运行 delta</div>
              <ListBlock items={detail.deltas.map((delta) => `${delta.runId} · ${delta.completed.join('；') || delta.changedFiles.join('；') || '无摘要'}`)} empty="暂无运行 delta" />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-zinc-300">结果复盘</div>
              <ListBlock items={detail.resultReviews.map((review) => `${review.decision} · ${review.actorUserId} · ${formatTime(review.createdAt)}${review.feedback ? ` · ${review.feedback}` : ''}`)} empty="暂无结果复盘" />
            </div>
          </div>
        </Section>

        <Section title="记忆候选" icon={<KeyRound className="h-3.5 w-3.5" />} testId="project-collab-detail-memory">
          <MemoryCandidateRows
            candidates={detail.memoryCandidates}
            onApproveMemory={onApproveMemory}
            onRejectMemory={onRejectMemory}
          />
        </Section>

        <Section title="Scope 审计" icon={<ShieldCheck className="h-3.5 w-3.5" />} testId="project-collab-detail-scope">
          <ScopeAudit readScope={currentRevision?.readScope} writeScope={currentRevision?.writeScope} />
        </Section>

        <Section title="决策" icon={<GitPullRequestArrow className="h-3.5 w-3.5" />}>
          <ListBlock items={detail.deltas.flatMap((delta) => delta.decisions)} empty="暂无决策" />
        </Section>
      </div>
    </aside>
  );
};

export default ProjectCollaborationDetailPane;
