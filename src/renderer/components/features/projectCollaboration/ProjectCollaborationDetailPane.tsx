import React, { useEffect, useState } from 'react';
import { Archive, Brain, Check, ChevronDown, ChevronRight, HelpCircle, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import type { NeoWorkCardDetail } from '@shared/contract/tag';
import type { Message } from '@shared/contract/message';
import {
  isInternalRuntimeText,
  NEO_WORK_CARD_PHASE_CHIP_STYLE,
  NEO_WORK_CARD_PHASE_LABEL,
  statusPhase,
} from '../chat/neoWorkCardPhase';
import {
  extractNeoTopicRounds,
  fetchConversationMessages,
  formatRequesterLabel,
  type NeoTopicRound,
} from './projectCollaborationData';

// ============================================================================
// Topic 详情（Neo Tag 轻量化重设计）
// 一个 topic = 一次 @neo 协作。详情展示真实内容：每轮请求原话 + Neo 最终回复
// （真源=源会话消息，delta 记账文案不进用户视野）、产物、记忆候选、跳回会话。
// ============================================================================

export interface ProjectCollaborationDetailPaneProps {
  detail: NeoWorkCardDetail | null;
  currentUser?: { id?: string | null; name?: string | null; email?: string | null } | null;
  /** 注入的源会话消息（测试/fixture 用）。传入时绕开 IPC 拉取。 */
  sourceMessages?: Message[];
  onOpenConversation?: (sessionId: string) => void;
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

const REPLY_CLAMP_CHARS = 600;

const RoundItem: React.FC<{ round: NeoTopicRound; index: number }> = ({ round, index }) => {
  const [expanded, setExpanded] = useState(false);
  const reply = round.reply ?? '';
  const needsClamp = reply.length > REPLY_CLAMP_CHARS;
  const shownReply = expanded || !needsClamp ? reply : `${reply.slice(0, REPLY_CLAMP_CHARS)}…`;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5" data-testid={`neo-topic-round-${index}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-[12px] leading-5 text-zinc-300">
          <span className="mr-1.5 rounded border border-zinc-800 bg-zinc-900 px-1 text-[10px] text-zinc-500">你</span>
          <span className="whitespace-pre-wrap break-words">{round.request}</span>
        </div>
        <span className="shrink-0 text-[10px] text-zinc-600">{formatTime(round.at)}</span>
      </div>
      <div className="mt-2 flex items-start gap-1.5">
        <span className="mt-0.5 flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15">
          <Sparkles className="h-2 w-2 text-emerald-300" />
        </span>
        {round.reply ? (
          <div className="min-w-0 flex-1 text-[12px] leading-5 text-zinc-400">
            <span className="whitespace-pre-wrap break-words">{shownReply}</span>
            {needsClamp && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-emerald-300/80 hover:text-emerald-200"
              >
                {expanded ? <>收起<ChevronDown className="h-3 w-3" /></> : <>展开<ChevronRight className="h-3 w-3" /></>}
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[12px] text-zinc-600">
            <Loader2 className="h-3 w-3 animate-spin" />还没有回复
          </div>
        )}
      </div>
    </div>
  );
};

export const ProjectCollaborationDetailPane: React.FC<ProjectCollaborationDetailPaneProps> = ({
  detail,
  currentUser,
  sourceMessages,
  onOpenConversation,
  onCancel,
  onArchive,
  onApproveMemory,
}) => {
  const sourceConversationId = detail?.workCard.sourceConversationId ?? null;
  const detailUpdatedAt = detail?.workCard.updatedAt ?? 0;
  const [loadedMessages, setLoadedMessages] = useState<Message[]>([]);

  // 注入了 sourceMessages（测试/fixture）就不走 IPC；否则按会话拉取，topic 有更新时重拉
  useEffect(() => {
    if (sourceMessages !== undefined || !sourceConversationId) return;
    let cancelled = false;
    void fetchConversationMessages(sourceConversationId).then((messages) => {
      if (!cancelled) setLoadedMessages(messages);
    });
    return () => { cancelled = true; };
  }, [sourceMessages, sourceConversationId, detailUpdatedAt]);

  if (!detail) {
    return (
      <div
        className="hidden min-h-0 items-center justify-center px-6 text-center text-sm text-zinc-600 xl:flex"
        data-testid="neo-topic-detail-empty"
      >
        选一个 topic 看每轮执行结果和产物。
      </div>
    );
  }

  const { workCard, deltas } = detail;
  const phase = statusPhase(workCard.status);
  const latestDelta = deltas.at(-1);
  const rounds = extractNeoTopicRounds(sourceMessages ?? loadedMessages, workCard.id);
  const checklist = uniqueNonEmpty(deltas.flatMap((delta) => delta.completed)).filter(
    (item) => !isInternalRuntimeText(item),
  );
  const changedFiles = uniqueNonEmpty(deltas.flatMap((delta) => delta.changedFiles));
  const openQuestions = uniqueNonEmpty(latestDelta?.openQuestions ?? []).filter((item) => !isInternalRuntimeText(item));
  const errors = uniqueNonEmpty(latestDelta?.risks ?? []);
  const pendingMemory = detail.memoryCandidates.filter((candidate) => candidate.status === 'pending');
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
        {onOpenConversation && (
          <button
            type="button"
            onClick={() => onOpenConversation(workCard.sourceConversationId)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 text-xs text-emerald-200 hover:bg-emerald-500/15"
            data-testid="neo-topic-detail-open-conversation"
          >
            <MessageSquare className="h-3 w-3" />打开会话
          </button>
        )}
      </div>

      {/* 进行中 */}
      {phase === 'running' && (
        <div className="mt-3 flex items-start gap-1.5 text-[13px] leading-5 text-emerald-100/90">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-emerald-300" />
          <span>Neo 正在处理…</span>
        </div>
      )}

      {/* 待你确认 */}
      {phase === 'needs_input' && (
        <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[13px] leading-5 text-amber-100/90">
          <div className="mb-1 flex items-center gap-1 text-amber-200/80"><HelpCircle className="h-3.5 w-3.5" />待你确认</div>
          {openQuestions.length > 0
            ? openQuestions.map((question, index) => <div key={index}>· {question}</div>)
            : <div>Neo 在会话里等你补充信息，打开会话回它一句。</div>}
        </div>
      )}

      {/* 失败 */}
      {phase === 'failed' && errors.length > 0 && (
        <div className="mt-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-[13px] leading-5 text-rose-100/90">
          {errors.map((error, index) => <div key={index}>{error}</div>)}
        </div>
      )}

      {/* 每轮执行结果（真源=源会话消息） */}
      {rounds.length > 0 && (
        <div className="mt-4" data-testid="neo-topic-detail-rounds">
          <div className="mb-1.5 text-[11px] font-medium text-zinc-500">
            执行结果{rounds.length > 1 ? ` · ${rounds.length} 轮` : ''}
          </div>
          <div className="grid gap-2">
            {rounds.map((round, index) => (
              <RoundItem key={`${round.at}-${index}`} round={round} index={index} />
            ))}
          </div>
        </div>
      )}

      {/* agent 自报的工作清单（记账文案已滤掉） */}
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
