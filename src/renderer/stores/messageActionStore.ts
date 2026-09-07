// ============================================================================
// MessageAction Store - Edit & Regenerate message actions
// ============================================================================
// Lightweight store that decouples message action UI (in MessageBubble)
// from the send logic (in ChatView/useAgent).
// ChatView registers the sender; MessageBubble consumes it.
// ============================================================================

import { create } from 'zustand';
import type { Message } from '@shared/contract';
import type { CreateSessionForkResult } from '@shared/contract/sessionFork';
import type { SessionForkWorkspaceMode } from '@shared/contract/sessionFork';
import type { MessageAttachment } from '@shared/contract';
import type { ConversationEnvelopeContext } from '@shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useSessionStore } from './sessionStore';
import { toast } from '../hooks/useToast';

/**
 * ADR-040：定点反馈要把结构化锚点和文本一起送出，所以发送口带 context。
 * 锚点走 envelope.context（host 补 revision 后落 message metadata），文本仍走 content——
 * 两者内容一致但用途不同：文本给模型读，锚点给写前 guard 对账。
 */
type SendContext = Pick<ConversationEnvelopeContext, 'localityAnchor'> & {
  /** 重试时把原消息的附件一起带回去——只带文本等于让用户丢文件（ai-review #1694 第四轮）。 */
  attachments?: MessageAttachment[];
  /**
   * 失败气泡 / 错误卡重试复用的原 clientMessageId。
   * 不带则走新 UUID（已成功轮 regenerate 必须新开，不能替换原气泡）。
   */
  clientMessageId?: string;
};

type RestoreComposerDraft = {
  content: string;
  attachments?: MessageAttachment[];
  clientMessageId: string;
};

type SendFn = (content: string, context?: SendContext) => void | Promise<void>;
type RestoreComposerFn = (draft: RestoreComposerDraft) => void;

interface MessageActionState {
  /** Registered send function (set by ChatView) */
  _send: SendFn | null;
  /** Registered messages accessor (set by ChatView) */
  _getMessages: (() => Message[]) | null;
  /** Registered composer restore (set by ChatView) — 失败气泡「编辑重发」把原文填回输入框。 */
  _restoreComposer: RestoreComposerFn | null;

  /** Register sender — call once from ChatView */
  register: (
    send: SendFn,
    getMessages: () => Message[],
    restoreComposer?: RestoreComposerFn,
  ) => void;
  /** Unregister on unmount */
  unregister: () => void;
  /** Send a plain prompt through the registered chat sender. */
  sendPrompt: (content: string, context?: SendContext) => Promise<void>;

  /** Regenerate an assistant message: re-send the preceding user message */
  regenerateMessage: (messageId: string) => void;
  /** 失败用户气泡：把原文和附件取回 composer，发出时复用同一个 clientMessageId。 */
  editAndResendMessage: (messageId: string) => void;
  /** Regenerate the most recent assistant message (keyboard shortcut entry, no hover needed). Returns true if one was found. */
  regenerateLast: () => boolean;
  /** Create an independent child session from a completed assistant reply. */
  createForkFromReply: (
    messageId: string,
    workspaceMode?: SessionForkWorkspaceMode,
  ) => Promise<void>;
}

function createForkIdempotencyKey(sourceSessionId: string, anchorAssistantMessageId: string): string {
  return `fork:${sourceSessionId}:${anchorAssistantMessageId}:${crypto.randomUUID()}`;
}

export const useMessageActionStore = create<MessageActionState>((set, get) => ({
  _send: null,
  _getMessages: null,
  _restoreComposer: null,

  register: (send, getMessages, restoreComposer) => set({
    _send: send,
    _getMessages: getMessages,
    _restoreComposer: restoreComposer ?? null,
  }),
  unregister: () => set({ _send: null, _getMessages: null, _restoreComposer: null }),

  sendPrompt: async (content: string, context?: SendContext) => {
    const { _send } = get();
    if (!_send) return;
    await _send(content, context);
  },

  regenerateMessage: (messageId: string) => {
    const { _send, _getMessages } = get();
    if (!_send || !_getMessages) return;

    const messages = _getMessages();
    const sessionId = useSessionStore.getState().currentSessionId;
    const running = Boolean(
      sessionId && useSessionStore.getState().isSessionRunning(sessionId),
    );
    // Find the assistant message, then look backward for the preceding user message
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    // 失败用户气泡留在时间线上；错误消息仍可挂 retryPrompt / retryClientMessageId。
    // 有锚点就用锚点——否则往回找会命中**上一轮**的提问，把已经答完的问题重发一遍。
    const anchor = messages[idx].metadata as
      {
        retryPrompt?: unknown;
        retryAttachments?: unknown;
        retrySessionId?: unknown;
        retryClientMessageId?: unknown;
      } | undefined;
    // 锚点绑了会话就必须对得上：错误消息会落到**当下**的会话，跨会话重试等于把
    // A 的内容和附件发进 B，污染 B 的上下文（ai-review #1694 第六轮）。
    // 对不上就当没有锚点，回落到往回找——那条路本来就只看本会话的消息。
    const anchorSessionId = typeof anchor?.retrySessionId === 'string' ? anchor.retrySessionId : undefined;
    const anchorUsable = !anchorSessionId
      || anchorSessionId === useSessionStore.getState().currentSessionId;
    const retryPrompt = anchor?.retryPrompt;
    const retryAttachments = Array.isArray(anchor?.retryAttachments)
      ? (anchor.retryAttachments as MessageAttachment[])
      : undefined;
    const retryClientMessageId = typeof anchor?.retryClientMessageId === 'string'
      ? anchor.retryClientMessageId
      : undefined;
    // 时间线上同 id 的当前用户消息是真源：A 失败 → 编辑成 B 再失败后，点第一张
    // 错误卡不能把化石 retryPrompt（A）覆盖掉已经在气泡上的 B。
    if (anchorUsable && retryClientMessageId) {
      const liveUser = messages.find(
        (message) => message.id === retryClientMessageId && message.role === 'user',
      );
      if (liveUser && (liveUser.content?.trim() || liveUser.attachments?.length)) {
        const retryContext = {
          ...(liveUser.attachments?.length ? { attachments: liveUser.attachments } : {}),
          clientMessageId: retryClientMessageId,
        };
        _send(liveUser.content ?? '', retryContext);
        return;
      }
    }
    // 纯附件消息的 retryPrompt 是空串——有附件就照样能重试，别按文本判。
    // 没有同 id 用户气泡时才退回锚点化石（旧路径：乐观气泡曾被删掉）。
    if (anchorUsable && typeof retryPrompt === 'string' && (retryPrompt.trim() || retryAttachments?.length)) {
      const retryContext = {
        ...(retryAttachments?.length ? { attachments: retryAttachments } : {}),
        ...(retryClientMessageId ? { clientMessageId: retryClientMessageId } : {}),
      };
      if (Object.keys(retryContext).length > 0) _send(retryPrompt, retryContext);
      else _send(retryPrompt);
      return;
    }

    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && (messages[i].content?.trim() || messages[i].attachments?.length)) {
        const failed = messages[i].metadata?.sendFailed === true;
        if (running && !failed) return;
        const retryContext = {
          ...(messages[i].attachments?.length ? { attachments: messages[i].attachments } : {}),
          ...(failed && messages[i].id ? { clientMessageId: messages[i].id } : {}),
        };
        const prompt = messages[i].content ?? '';
        if (Object.keys(retryContext).length > 0) _send(prompt, retryContext);
        else _send(prompt);
        return;
      }
    }
  },

  editAndResendMessage: (messageId) => {
    const { _restoreComposer, _getMessages } = get();
    if (!_restoreComposer || !_getMessages) return;
    const target = _getMessages().find((message) => message.id === messageId);
    if (target?.role !== 'user' || target.metadata?.sendFailed !== true || !target.id) return;
    if (!target.content?.trim() && !target.attachments?.length) return;
    _restoreComposer({
      content: target.content ?? '',
      ...(target.attachments?.length ? { attachments: target.attachments } : {}),
      clientMessageId: target.id,
    });
  },

  regenerateLast: () => {
    const { _getMessages, regenerateMessage } = get();
    if (!_getMessages) return false;
    const messages = _getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].id) {
        regenerateMessage(messages[i].id!);
        return true;
      }
    }
    return false;
  },

  createForkFromReply: async (messageId: string, workspaceMode = 'shared_current') => {
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.currentSessionId;
    if (!sessionId) return;
    if (sessionStore.isSessionRunning(sessionId)) {
      toast.error('任务仍在运行，停止后才能创建分支');
      return;
    }

    try {
      const result = await ipcService.invokeDomain<CreateSessionForkResult>(
        IPC_DOMAINS.SESSION,
        'fork',
        {
          sourceSessionId: sessionId,
          anchorAssistantMessageId: messageId,
          idempotencyKey: createForkIdempotencyKey(sessionId, messageId),
          workspaceMode,
        },
      );
      // The source task remains untouched. Refresh the list so lineage is visible,
      // then load the independently persisted child through the normal session path.
      await useSessionStore.getState().loadSessions({ silent: true });
      await useSessionStore.getState().switchSession(result.childSession.id);
      toast.success(`已创建分支任务：${result.workspaceLabel}`);
    } catch (error) {
      toast.error(`创建分支失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
}));
