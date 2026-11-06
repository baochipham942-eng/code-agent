// ============================================================================
// useCronRunFollowUpSend — 定时任务运行记录的「接着问这次运行」（N-UI-CRON-RUN-RECORD-CLEAR）
// ----------------------------------------------------------------------------
// 运行记录会话本体保持只读（执行台账依赖它不被改写），但 composer 照常可用：
// 发送不在原会话里跑——先从最后一次完成的助手回复 fork 出子会话（任务 + 过程 +
// 结果作为历史前缀照抄，SessionForkService 负责），切过去再把 envelope 重定向到
// 子会话投递。原记录一行不改；每次发送都开一条新分支。
// 与 useImportedSessionResumeSend 同一模式（导入外部历史续聊），锚点判据同源。
// ============================================================================

import { useCallback } from 'react';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { CreateSessionForkResult } from '@shared/contract/sessionFork';
import type { Message } from '@shared/contract';
import type { Session } from '@shared/contract/session';
import { stripCronPromptDecoration } from '@shared/cronRunMessage';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  deriveCronRunStatusLine,
  findCronExecutionForSession,
  getObservedCronRunStatusForSession,
} from '../components/features/chat/cronRunSessionStatus';
import ipcService from '../services/ipcService';
import { useCronStore } from '../stores/cronStore';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from './useI18n';
import { toast } from './useToast';

/** origin.kind 为 cron/heartbeat 的运行记录会话。 */
function isCronRunRecordSession(session: Session | null | undefined): boolean {
  const kind = session?.origin?.kind;
  return kind === 'cron' || kind === 'heartbeat';
}

function resolveSessionRunStatusKind(session: Session | null | undefined, sessionId: string) {
  const observed = getObservedCronRunStatusForSession(sessionId);
  if (observed) return observed.kind;
  const jobId = session?.origin?.id?.trim();
  if (!jobId) return null;
  const cronState = useCronStore.getState();
  const latestForJob = cronState.latestExecutions[jobId];
  const candidates = [
    ...(cronState.executionsByJobId[jobId] ?? []),
    ...(latestForJob ? [latestForJob] : []),
    ...cronState.recentExecutions.filter((item) => item.jobId === jobId),
  ];
  const execution = findCronExecutionForSession(candidates, { executionId: session?.sourceRunId, sessionId });
  return deriveCronRunStatusLine({ execution, pendingApproval: null })?.kind ?? null;
}

/**
 * Fork 锚点判据与 host `SessionForkRepository.createFork` 对齐：最后一条完整
 * 助手回复（非 meta、有正文、无 tool_calls）——那次运行的结果（或中断前的最后
 * 一段输出）。整段历史没有助手回复（中断得太早）时无锚可 fork，走无结果兜底。
 */
function findCompletedAssistantReplyAnchor(messages: Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (message.isMeta || message.visibility === 'rewound') continue;
    if (!message.content?.trim()) continue;
    if (message.toolCalls?.length) continue;
    return message;
  }
  return null;
}

async function forkCronRunRecord(
  sourceSessionId: string,
  anchorAssistantMessageId: string,
): Promise<CreateSessionForkResult> {
  return await ipcService.invokeDomain<CreateSessionForkResult>(
    IPC_DOMAINS.SESSION,
    'fork',
    {
      sourceSessionId,
      anchorAssistantMessageId,
      idempotencyKey: `cron-followup:${sourceSessionId}:${anchorAssistantMessageId}:${crypto.randomUUID()}`,
      workspaceMode: 'shared_current',
    },
  );
}

type SendEnvelopeFn = (envelope: ConversationEnvelope) => Promise<boolean>;

/**
 * 发送包装器：运行记录会话里每次发送都 fork→切换→重定向，再走原发送链。
 * 失败时返回 false（composer 恢复草稿）并给一句人话 toast，不裸抛错误码。
 */
export function useCronRunFollowUpSend(
  send: SendEnvelopeFn,
  getMessages: () => Message[],
): SendEnvelopeFn {
  const { t } = useI18n();
  const copy = t.chatInput;
  return useCallback(async (envelope) => {
    const sessionStore = useSessionStore.getState();
    const sessionId = envelope.sessionId ?? sessionStore.currentSessionId;
    const session = sessionId
      ? sessionStore.sessions.find((item) => item.id === sessionId) ?? null
      : null;
    if (!isCronRunRecordSession(session) || !sessionId) return await send(envelope);
    if (sessionStore.isSessionRunning(sessionId)) {
      // 运行进行中：fork 会被 host 拒（SESSION_RUNNING），排队又会写进记录会话。
      // 两头都不去，把话还给用户、说清什么时候可以接着问。
      toast.info(copy.cronFollowUpRunActive);
      return false;
    }
    try {
      const anchor = findCompletedAssistantReplyAnchor(getMessages());
      if (anchor?.id) {
        // 有结果（或中断前的最后输出）：fork 带走完整历史，用户这句话照原样发出。
        const result = await forkCronRunRecord(sessionId, anchor.id);
        await useSessionStore.getState().loadSessions({ silent: true });
        await useSessionStore.getState().switchSession(result.childSession.id);
        return await send({ ...envelope, sessionId: result.childSession.id });
      }
      // 中断得太早、没有任何助手输出：没有锚点 fork 不了，开普通新会话，
      // 把任务原文随这句话一起带过去（那条记录里没有结果可带）。
      const taskText = stripCronPromptDecoration(
        getMessages().find((message) => message.role === 'user' && message.content?.trim())?.content ?? '',
      ).trim();
      const created = await useSessionStore.getState().createSession(
        copy.cronFollowUpNewSessionTitle.replace('{title}', sessionStore.sessions.find((item) => item.id === sessionId)?.title ?? ''),
      );
      if (!created) {
        toast.error(copy.cronFollowUpCreateFailed);
        return false;
      }
      const statusKind = resolveSessionRunStatusKind(session, sessionId);
      // 仅在进程中断（interrupted，或未记录为 failed/cancelled）时称「中断了，没有留下结果」；
      // 失败或取消的运行不说「中断了，没有留下结果」。
      const isFailedOrCancelled =
        statusKind === 'failed-denied'
        || statusKind === 'failed-generic'
        || statusKind === 'cancelled'
        || session?.status === 'error';
      const seedPrefix = isFailedOrCancelled
        ? (taskText
          ? copy.cronFollowUpSeedIncompleteWithTask.replace('{task}', taskText)
          : copy.cronFollowUpSeedIncompleteNoTask)
        : (taskText
          ? copy.cronFollowUpSeedWithTask.replace('{task}', taskText)
          : copy.cronFollowUpSeedNoTask);
      return await send({
        ...envelope,
        sessionId: created.id,
        content: `${seedPrefix}\n\n${envelope.content}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(copy.cronFollowUpForkFailed.replace('{reason}', reason));
      return false;
    }
  }, [copy, getMessages, send]);
}
