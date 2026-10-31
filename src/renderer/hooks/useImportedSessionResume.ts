// ============================================================================
// useImportedSessionResume — 导入外部历史的「发送即分支续聊」（N-EXTHISTORY-IMPORT-CHATS-RESUME）
// ----------------------------------------------------------------------------
// 导入的 Claude Code / Codex CLI 会话是只读记录：composer 保持可见，但发送不在
// 原会话里跑——先从最后一条助手回复 fork 出一个 Neo 原生子会话（历史前缀照抄、
// 模型用新建会话默认值，host 侧 SessionForkService 负责），切过去再把 envelope
// 重定向到子会话投递。原会话行永不改写；每次发送都开一条新分支。
// ============================================================================

import { useCallback, useMemo } from 'react';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { CreateSessionForkResult } from '@shared/contract/sessionFork';
import type { Message } from '@shared/contract';
import type { Session } from '@shared/contract/session';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from './useI18n';
import { toast } from './useToast';

type ImportedHistoryEngineKind = 'claude_code' | 'codex_cli';

type ImportedHistorySession = Session & {
  engine: { kind: ImportedHistoryEngineKind; origin: 'import' };
};

/** 引擎 origin=import 且 kind 是外部 CLI —— 导入的历史记录会话。 */
function isImportedExternalHistorySession(
  session: Session | null | undefined,
): session is ImportedHistorySession {
  return session?.engine?.origin === 'import'
    && (session.engine.kind === 'claude_code' || session.engine.kind === 'codex_cli');
}

/**
 * Fork 锚点判据与 host `SessionForkRepository.createFork` 对齐：取最后一条完整
 * 助手回复（非 meta、有正文、无 tool_calls）——host 按锚点截取前缀，锚点后未获
 * 回答的尾随用户消息不进子会话。整段历史没有助手回复时无锚可 fork。
 */
function findImportedForkAnchor(messages: Message[]): Message | null {
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

type ImportedSessionSendPlan =
  | { mode: 'passthrough' }
  | { mode: 'fork'; anchorAssistantMessageId: string }
  | { mode: 'blocked_no_anchor' };

/** 纯决策：非导入会话直通；导入会话有尾锚点→fork；无锚点→阻断。 */
function resolveImportedSessionSendPlan(input: {
  session: Session | null | undefined;
  messages: Message[];
}): ImportedSessionSendPlan {
  if (!isImportedExternalHistorySession(input.session)) return { mode: 'passthrough' };
  const anchor = findImportedForkAnchor(input.messages);
  if (!anchor?.id) return { mode: 'blocked_no_anchor' };
  return { mode: 'fork', anchorAssistantMessageId: anchor.id };
}

/** 把 envelope 的投递目标改到 fork 子会话（envelope.sessionId 优先于 currentSessionId）。 */
function retargetEnvelopeToForkChild(
  envelope: ConversationEnvelope,
  childSessionId: string,
): ConversationEnvelope {
  return { ...envelope, sessionId: childSessionId };
}

async function createImportedSessionFork(
  sourceSessionId: string,
  anchorAssistantMessageId: string,
): Promise<CreateSessionForkResult> {
  return await ipcService.invokeDomain<CreateSessionForkResult>(
    IPC_DOMAINS.SESSION,
    'fork',
    {
      sourceSessionId,
      anchorAssistantMessageId,
      idempotencyKey: `fork:${sourceSessionId}:${anchorAssistantMessageId}:${crypto.randomUUID()}`,
      workspaceMode: 'shared_current',
    },
  );
}

type SendEnvelopeFn = (envelope: ConversationEnvelope) => Promise<boolean>;

/**
 * 发送包装器：导入会话里每次发送都先 fork→切换→重定向，再走原发送链。
 * 失败/无锚点时返回 false（composer 恢复草稿），并给一句人话 toast，不裸抛错误码。
 */
export function useImportedSessionResumeSend(
  send: SendEnvelopeFn,
  getMessages: () => Message[],
): SendEnvelopeFn {
  const { t } = useI18n();
  return useCallback(async (envelope: ConversationEnvelope) => {
    const sessionStore = useSessionStore.getState();
    const sessionId = envelope.sessionId ?? sessionStore.currentSessionId;
    const session = sessionId
      ? sessionStore.sessions.find((item) => item.id === sessionId) ?? null
      : null;
    const plan = resolveImportedSessionSendPlan({ session, messages: getMessages() });
    if (plan.mode === 'passthrough') return await send(envelope);
    if (plan.mode === 'blocked_no_anchor') {
      toast.info(t.chatInput.importedSendBlocked);
      return false;
    }
    if (!sessionId || sessionStore.isSessionRunning(sessionId)) return false;
    try {
      const result = await createImportedSessionFork(sessionId, plan.anchorAssistantMessageId);
      await useSessionStore.getState().loadSessions({ silent: true });
      await useSessionStore.getState().switchSession(result.childSession.id);
      return await send(retargetEnvelopeToForkChild(envelope, result.childSession.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(t.chatInput.importedForkFailed.replace('{reason}', reason));
      return false;
    }
  }, [getMessages, send, t]);
}

export type ImportedSessionNoticeState = {
  kind: 'explain' | 'no_anchor';
  engineKind: ImportedHistoryEngineKind;
};

/** composer 上方那行说明文案的状态：导入会话才有；区分「可续接」与「暂无可续接回复」。 */
export function useImportedSessionNotice(): ImportedSessionNoticeState | null {
  const session = useSessionStore((s) =>
    s.sessions.find((item) => item.id === s.currentSessionId) ?? null);
  const messages = useSessionStore((s) => s.messages);
  const hydrating = useSessionStore((s) => s.isLoading || s.isHydratingSession);
  return useMemo(() => {
    if (!isImportedExternalHistorySession(session)) return null;
    // 消息还在装载时不给结论：空数组会被误判成「暂无可续接回复」，等 hydration 落定。
    if (hydrating && messages.length === 0) return null;
    const plan = resolveImportedSessionSendPlan({ session, messages });
    return {
      kind: plan.mode === 'fork' ? 'explain' : 'no_anchor',
      engineKind: session.engine.kind,
    };
  }, [hydrating, session, messages]);
}
