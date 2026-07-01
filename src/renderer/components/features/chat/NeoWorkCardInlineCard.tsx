import React, { useCallback } from 'react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '@shared/contract/tag';
import { AlertTriangle, Archive, Brain, Check, HelpCircle, Loader2, Sparkles, X } from 'lucide-react';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { useNeoWorkCardStore } from '../../../stores/neoWorkCardStore';

// ============================================================================
// 轻量内联清单（Neo Tag 轻量化重设计）
// @neo 像同事一样被 tag 进对话、直接开干；进度 = thread 内联勾选清单 ✓/⏳，
// 不再是带审批/读写范围/模型表单的独立重卡。审批语义已砍，权限走项目级 ambient。
// ============================================================================

/** 四相运行态（收敛掉审批态）：运行中 / 待你确认 / 已完成 / 失败 / 已结束。 */
export type NeoWorkCardPhase = 'running' | 'needs_input' | 'done' | 'failed' | 'closed';

type NeoWorkCardInlineActionKind = 'cancel' | 'archive';

interface NeoWorkCardStatusAction {
  action: NeoWorkCardInlineActionKind;
  label: string;
  icon: React.ElementType;
}

const PHASE_BY_STATUS: Record<NeoWorkCardStatus, NeoWorkCardPhase> = {
  draft: 'running',
  needs_review: 'running',
  approved: 'running',
  queued: 'running',
  working: 'running',
  waiting_for_user: 'needs_input',
  in_result_review: 'done',
  completed: 'done',
  failed: 'failed',
  cancelled: 'closed',
  archived: 'closed',
};

const PHASE_LABEL: Record<NeoWorkCardPhase, string> = {
  running: '运行中',
  needs_input: '待你确认',
  done: '已完成',
  failed: '失败',
  closed: '已结束',
};

const PHASE_CHIP_STYLE: Record<NeoWorkCardPhase, string> = {
  running: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  needs_input: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  done: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  closed: 'border-zinc-800 bg-zinc-950 text-zinc-500',
};

// 运行时生命周期内部标记，不是用户视角的工作项，从清单里滤掉。
const INTERNAL_COMPLETED_MARKERS = [
  /^Queued approved revision/i,
  /^Local Neo runtime run finished/i,
];

export function statusPhase(status: NeoWorkCardStatus): NeoWorkCardPhase {
  return PHASE_BY_STATUS[status] ?? 'running';
}

function isInternalCompletedMarker(item: string): boolean {
  return INTERNAL_COMPLETED_MARKERS.some((pattern) => pattern.test(item.trim()));
}

export function getNeoWorkCardStatusActions(status: NeoWorkCardStatus): NeoWorkCardStatusAction[] {
  if (status === 'archived') return [];
  const phase = statusPhase(status);
  // 运行中 / 待确认：只保留「取消」（不是审批，是停止在跑的活）
  if (phase === 'running' || phase === 'needs_input') {
    return [{ action: 'cancel', label: '取消', icon: X }];
  }
  // 已完成 / 失败 / 已取消：只保留「归档」
  return [{ action: 'archive', label: '归档', icon: Archive }];
}

function uniqueNonEmpty(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export const NeoWorkCardInlineCard: React.FC<{ detail: NeoWorkCardDetail }> = ({ detail }) => {
  const actorUserId = useAuthStore((state) => state.user?.id ?? detail.workCard.requesterUserId);
  const pending = useNeoWorkCardStore((state) => Boolean(state.pendingStatusById[detail.workCard.id]));
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);

  const { workCard, deltas } = detail;
  const phase = statusPhase(workCard.status);
  const latestDelta = deltas.at(-1);
  const actions = getNeoWorkCardStatusActions(workCard.status);

  const checklist = uniqueNonEmpty(deltas.flatMap((delta) => delta.completed)).filter(
    (item) => !isInternalCompletedMarker(item),
  );
  const changedFiles = uniqueNonEmpty(latestDelta?.changedFiles ?? []);
  const openQuestions = uniqueNonEmpty(latestDelta?.openQuestions ?? []);
  const errors = uniqueNonEmpty(latestDelta?.risks ?? []);
  const pendingMemory = detail.memoryCandidates.filter((candidate) => candidate.status === 'pending');
  const progressText = latestDelta?.nextStep?.trim() || 'Neo 正在处理…';

  const handleAction = useCallback(async (action: NeoWorkCardInlineActionKind) => {
    try {
      if (action === 'cancel') {
        await cancel({ workCardId: workCard.id, actorUserId });
      } else if (action === 'archive') {
        await archive({ workCardId: workCard.id, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新 Neo 任务失败');
    }
  }, [actorUserId, archive, cancel, workCard.id]);

  const handleApproveMemory = useCallback(async (candidateId: string) => {
    try {
      await approveMemoryCandidate({ candidateId, actorUserId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '写入记忆失败');
    }
  }, [actorUserId, approveMemoryCandidate]);

  return (
    <div
      className="w-full max-w-3xl rounded-lg border border-emerald-400/20 bg-zinc-900/70 px-3.5 py-3 text-sm"
      data-testid="neo-work-card"
      data-work-card-id={workCard.id}
      data-work-card-status={workCard.status}
      data-work-card-phase={phase}
    >
      {/* 头：Neo + 标题 + 相位 chip（融进 thread 的一条回复，不是独立大卡） */}
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-emerald-300" />
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-emerald-200/80">Neo</span>
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-100">{workCard.title}</span>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${PHASE_CHIP_STYLE[phase]}`}
        >
          {phase === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {phase === 'done' && <Check className="h-3 w-3" />}
          {phase === 'failed' && <AlertTriangle className="h-3 w-3" />}
          {phase === 'needs_input' && <HelpCircle className="h-3 w-3" />}
          {PHASE_LABEL[phase]}
        </span>
      </div>

      {/* 内联勾选清单：已完成项 ✓ */}
      {checklist.length > 0 && (
        <ul className="mt-2.5 grid gap-1" data-testid="neo-work-card-checklist">
          {checklist.map((item, index) => (
            <li key={`${index}-${item}`} className="flex items-start gap-1.5 text-[13px] leading-5 text-zinc-300">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 进行中项 ⏳ */}
      {phase === 'running' && (
        <div
          className="mt-2 flex items-start gap-1.5 text-[13px] leading-5 text-emerald-100/90"
          data-testid="neo-work-card-progress"
        >
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-emerald-300" />
          <span className="min-w-0">{progressText}</span>
        </div>
      )}

      {/* 改动的文件（若运行追踪到） */}
      {changedFiles.length > 0 && (
        <div className="mt-2 text-xs text-zinc-500" data-testid="neo-work-card-files">
          改动：{changedFiles.slice(0, 5).join('、')}
        </div>
      )}

      {/* 待你确认 */}
      {phase === 'needs_input' && openQuestions.length > 0 && (
        <div
          className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-2 text-[13px] leading-5 text-amber-100/90"
          data-testid="neo-work-card-needs-input"
        >
          {openQuestions.map((question, index) => (
            <div key={index}>· {question}</div>
          ))}
        </div>
      )}

      {/* 失败 */}
      {phase === 'failed' && errors.length > 0 && (
        <div
          className="mt-2 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-2.5 py-2 text-[13px] leading-5 text-rose-100/90"
          data-testid="neo-work-card-error"
        >
          {errors.slice(0, 3).map((error, index) => (
            <div key={index}>{error}</div>
          ))}
        </div>
      )}

      {/* 记忆候选：轻提示（非表单），一键写入 */}
      {pendingMemory.length > 0 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fuchsia-100/80"
          data-testid="neo-work-card-memory-hint"
        >
          <Brain className="h-3.5 w-3.5 shrink-0 text-fuchsia-300" />
          <span className="text-fuchsia-200/70">可记住：</span>
          {pendingMemory.slice(0, 3).map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => handleApproveMemory(candidate.id)}
              className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-md border border-fuchsia-400/25 bg-fuchsia-400/10 px-1.5 py-0.5 text-[11px] text-fuchsia-100 hover:bg-fuchsia-400/15"
              data-testid={`neo-work-card-approve-memory-${candidate.id}`}
              title="写入项目记忆"
            >
              <span className="min-w-0 truncate">{candidate.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* 轻量收尾动作：运行中→取消 / 终态→归档（无审批按钮） */}
      {actions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.action}
                type="button"
                disabled={pending}
                onClick={() => handleAction(action.action)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700/70 bg-zinc-800/60 px-2 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                title={action.label}
                data-testid={`neo-work-card-action-${action.action}`}
              >
                <Icon className="h-3 w-3" />
                <span>{pending ? '更新中' : action.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
