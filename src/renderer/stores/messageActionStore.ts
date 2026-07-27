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
type SendContext = Pick<ConversationEnvelopeContext, 'localityAnchor'>;
type SendFn = (content: string, context?: SendContext) => void | Promise<void>;

interface MessageActionState {
  /** Registered send function (set by ChatView) */
  _send: SendFn | null;
  /** Registered messages accessor (set by ChatView) */
  _getMessages: (() => Message[]) | null;

  /** Register sender — call once from ChatView */
  register: (send: SendFn, getMessages: () => Message[]) => void;
  /** Unregister on unmount */
  unregister: () => void;
  /** Send a plain prompt through the registered chat sender. */
  sendPrompt: (content: string, context?: SendContext) => Promise<void>;

  /** Regenerate an assistant message: re-send the preceding user message */
  regenerateMessage: (messageId: string) => void;
  /** Regenerate the most recent assistant message (keyboard shortcut entry, no hover needed). Returns true if one was found. */
  regenerateLast: () => boolean;
  /** Create an independent child session from a completed assistant reply. */
  forkFromHere: (messageId: string) => Promise<void>;
}

function createForkIdempotencyKey(sourceSessionId: string, anchorAssistantMessageId: string): string {
  return `fork:${sourceSessionId}:${anchorAssistantMessageId}:${crypto.randomUUID()}`;
}

export const useMessageActionStore = create<MessageActionState>((set, get) => ({
  _send: null,
  _getMessages: null,

  register: (send, getMessages) => set({ _send: send, _getMessages: getMessages }),
  unregister: () => set({ _send: null, _getMessages: null }),

  sendPrompt: async (content: string, context?: SendContext) => {
    const { _send } = get();
    if (!_send) return;
    await _send(content, context);
  },

  regenerateMessage: (messageId: string) => {
    const { _send, _getMessages } = get();
    if (!_send || !_getMessages) return;

    const messages = _getMessages();
    // Find the assistant message, then look backward for the preceding user message
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content?.trim()) {
        _send(messages[i].content!);
        return;
      }
    }
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

  forkFromHere: async (messageId: string) => {
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
          workspaceMode: 'shared_current',
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
