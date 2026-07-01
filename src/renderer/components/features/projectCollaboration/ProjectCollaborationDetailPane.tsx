import React from 'react';
import { Archive, Brain, Check, HelpCircle, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import type { NeoWorkCardDetail } from '@shared/contract/tag';
import {
  isInternalCompletedMarker,
  NEO_WORK_CARD_PHASE_CHIP_STYLE,
  NEO_WORK_CARD_PHASE_LABEL,
  statusPhase,
} from '../chat/neoWorkCardPhase';
import { formatRequesterLabel } from './projectCollaborationData';

// ============================================================================
// Topic 详情（Neo Tag 轻量化重设计）
// 一个 topic = 一次 @neo 协作。详情展示：对话/执行步骤、内联清单、产物、记忆候选。
// 砍掉旧的审批动作 / 读写范围 / 上下文审计 / 修订-审批时间线。
// ============================================================================

export interface ProjectCollaborationDetailPaneProps {
  detail: NeoWorkCardDetail | null;
  currentUser?: { id?: string | null; name?: string | null; email?: string | null } | null;
  onCancel?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function uniqueNonEmpty(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export const ProjectCollaborationDetailPane: React.FC<ProjectCollaborationDetailPaneProps> = ({
  detail,
  currentUser,
  onCancel,
  onArchive,
  onApproveMemory,
}) => {
  if (!detail) {
    return (
      <div
        className="hidden min-h-0 items-center justify-center px-6 text-center text-sm text-zinc-600 xl:flex"
        data-testid="neo-topic-detail-empty"
      >
        选一个 topic 看它的对话、执行步骤和产物。
      </div>
    );
  }

  const { workCard, deltas } = detail;
  const phase = statusPhase(workCard.status);
  const latestDelta = deltas.at(-1);
  const checklist = uniqueNonEmpty(deltas.flatMap((delta) => delta.completed)).filter(
    (item) => !isInternalCompletedMarker(item),
  );
  const changedFiles = uniqueNonEmpty(deltas.flatMap((delta) => delta.changedFiles));
  const openQuestions = uniqueNonEmpty(latestDelta?.openQuestions ?? []);
  const errors = uniqueNonEmpty(latestDelta?.risks ?? []);
  const pendingMemory = detail.memoryCandidates.filter((candidate) => candidate.status === 'pending');
  const steps = deltas
    .flatMap((delta) => [
      ...delta.completed.filter((item) => !isInternalCompletedMarker(item)).map((text) => ({ kind: '完成' as const, text, at: delta.createdAt })),
      ...delta.decisions.filter((item) => !item.startsWith('Context audit:')).map((text) => ({ kind: '决策' as const, text, at: delta.createdAt })),
      ...(delta.nextStep ? [{ kind: '下一步' as const, text: delta.nextStep, at: delta.createdAt }] : []),
    ]);
  const isActive = phase === 'running' || phase === 'needs_input';

  return (
    <div className="min-h-0 overflow-y-auto border-l border-zinc-800 px-4 py-4" data-testid="neo-topic-detail">
      {/* 头 */}
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-6 text-zinc-100">{workCard.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${NEO_WORK_CARD_PHASE_CHIP_STYLE[phase]}`}>
              {phase === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
              {NEO_WORK_CARD_PHASE_LABEL[phase]}
            </span>
            <span>发起人 {formatRequesterLabel(workCard.requesterUserId, currentUser)}</span>
            <span>更新于 {formatTime(workCard.updatedAt)}</span>
          </div>
        </div>
      </div>

      {/* 内联清单 */}
      {checklist.length > 0 && (
        <ul className="mt-4 grid gap-1.5" data-testid="neo-topic-detail-checklist">
          {checklist.map((item, index) => (
            <li key={`${index}-${item}`} className="flex items-start gap-1.5 text-[13px] leading-5 text-zinc-300">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 进行中 */}
      {phase === 'running' && (
        <div className="mt-3 flex items-start gap-1.5 text-[13px] leading-5 text-emerald-100/90">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-emerald-300" />
          <span>{latestDelta?.nextStep?.trim() || 'Neo 正在处理…'}</span>
        </div>
      )}

      {/* 待你确认 */}
      {phase === 'needs_input' && openQuestions.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[13px] leading-5 text-amber-100/90">
          <div className="mb-1 flex items-center gap-1 text-amber-200/80"><HelpCircle className="h-3.5 w-3.5" />待你确认</div>
          {openQuestions.map((question, index) => <div key={index}>· {question}</div>)}
        </div>
      )}

      {/* 失败 */}
      {phase === 'failed' && errors.length > 0 && (
        <div className="mt-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-[13px] leading-5 text-rose-100/90">
          {errors.map((error, index) => <div key={index}>{error}</div>)}
        </div>
      )}

      {/* 产物：改动的文件 */}
      {changedFiles.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-medium text-zinc-500">产物</div>
          <div className="grid gap-1" data-testid="neo-topic-detail-files">
            {changedFiles.slice(0, 20).map((file) => (
              <div key={file} className="truncate rounded border border-zinc-800 bg-zinc-950/45 px-2 py-1 text-[11px] text-zinc-400">{file}</div>
            ))}
          </div>
        </div>
      )}

      {/* 对话 / 执行步骤 */}
      {steps.length > 0 && (
        <div className="mt-4" data-testid="neo-topic-detail-steps">
          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-zinc-500">
            <MessageSquare className="h-3.5 w-3.5" />执行步骤
          </div>
          <ol className="grid gap-1.5">
            {steps.map((step, index) => (
              <li key={index} className="flex items-start gap-2 text-[12px] leading-5 text-zinc-400">
                <span className="mt-0.5 shrink-0 rounded border border-zinc-800 bg-zinc-950 px-1 text-[10px] text-zinc-500">{step.kind}</span>
                <span className="min-w-0">{step.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* 记忆候选 */}
      {pendingMemory.length > 0 && (
        <div className="mt-4" data-testid="neo-topic-detail-memory">
          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-fuchsia-200/70">
            <Brain className="h-3.5 w-3.5" />可记住
          </div>
          <div className="grid gap-1.5">
            {pendingMemory.map((candidate) => (
              <div key={candidate.id} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-fuchsia-400/15 bg-fuchsia-400/[0.05] px-2.5 py-1.5 text-[12px] text-fuchsia-100/90">
                <span className="min-w-0 truncate">{candidate.text}</span>
                <button
                  type="button"
                  onClick={() => onApproveMemory?.(candidate.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-fuchsia-400/25 bg-fuchsia-400/10 px-1.5 py-0.5 text-[11px] text-fuchsia-100 hover:bg-fuchsia-400/15"
                  data-testid={`neo-topic-detail-approve-memory-${candidate.id}`}
                >
                  写入记忆
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 收尾动作：活动中→取消 / 终态→归档 */}
      <div className="mt-5 flex flex-wrap gap-2">
        {isActive ? (
          <button
            type="button"
            onClick={() => onCancel?.(workCard.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700/70 bg-zinc-800/60 px-2 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            data-testid="neo-topic-detail-cancel"
          >
            <X className="h-3 w-3" />取消
          </button>
        ) : workCard.status !== 'archived' ? (
          <button
            type="button"
            onClick={() => onArchive?.(workCard.id)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700/70 bg-zinc-800/60 px-2 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            data-testid="neo-topic-detail-archive"
          >
            <Archive className="h-3 w-3" />归档
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default ProjectCollaborationDetailPane;
