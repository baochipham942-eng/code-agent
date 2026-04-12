// ============================================================================
// MessageAction Store - Edit & Regenerate message actions
// ============================================================================
// Lightweight store that decouples message action UI (in MessageBubble)
// from the send logic (in ChatView/useAgent).
// ChatView registers the sender; MessageBubble consumes it.
// ============================================================================

import { create } from 'zustand';
import type { Message } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useSessionStore } from './sessionStore';
import { toast } from '../hooks/useToast';

type SendFn = (content: string) => void;

interface MessageActionState {
  /** Registered send function (set by ChatView) */
  _send: SendFn | null;
  /** Registered messages accessor (set by ChatView) */
  _getMessages: (() => Message[]) | null;

  /** Register sender — call once from ChatView */
  register: (send: SendFn, getMessages: () => Message[]) => void;
  /** Unregister on unmount */
  unregister: () => void;

  /** Edit a user message: re-send with new content */
  editMessage: (messageId: string, newContent: string) => void;
  /** Regenerate an assistant message: re-send the preceding user message */
  regenerateMessage: (messageId: string) => void;
  /** Fork from a checkpoint: rewind files + truncate messages */
  forkFromHere: (messageId: string) => void;
}

export const useMessageActionStore = create<MessageActionState>((set, get) => ({
  _send: null,
  _getMessages: null,

  register: (send, getMessages) => set({ _send: send, _getMessages: getMessages }),
  unregister: () => set({ _send: null, _getMessages: null }),

  editMessage: (_messageId: string, newContent: string) => {
    const { _send } = get();
    if (!_send) return;
    _send(newContent);
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

  forkFromHere: async (messageId: string) => {
    const sessionId = useSessionStore.getState().currentSessionId;
    if (!sessionId) return;

    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CHECKPOINT_FORK, sessionId, messageId);
      if (result.success) {
        toast.success(`已回滚到此消息，可继续对话（恢复 ${result.filesRestored} 文件，截断 ${result.messagesTruncated} 条消息）`);
        // Refresh messages in the store by re-switching to the same session
        const { _getMessages } = get();
        if (_getMessages) {
          const messages = _getMessages();
          const idx = messages.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            useSessionStore.getState().setMessages(messages.slice(0, idx + 1));
          }
        }
      } else {
        toast.error(`回滚失败: ${result.error || '未知错误'}`);
      }
    } catch (error) {
      toast.error(`回滚失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
}));
