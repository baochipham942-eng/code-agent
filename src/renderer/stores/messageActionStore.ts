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

type SendFn = (content: string) => void | Promise<void>;

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
  sendPrompt: (content: string) => Promise<void>;

  /** Edit a user message: 截断被编辑消息及其后历史，再用新内容重发（真替换，非追加） */
  editMessage: (messageId: string, newContent: string) => void | Promise<void>;
  /** Regenerate an assistant message: re-send the preceding user message */
  regenerateMessage: (messageId: string) => void;
  /** Regenerate the most recent assistant message (keyboard shortcut entry, no hover needed). Returns true if one was found. */
  regenerateLast: () => boolean;
  /** Fork from a checkpoint: rewind files + truncate messages */
  forkFromHere: (messageId: string) => void;
}

export const useMessageActionStore = create<MessageActionState>((set, get) => ({
  _send: null,
  _getMessages: null,

  register: (send, getMessages) => set({ _send: send, _getMessages: getMessages }),
  unregister: () => set({ _send: null, _getMessages: null }),

  sendPrompt: async (content: string) => {
    const { _send } = get();
    if (!_send) return;
    await _send(content);
  },

  editMessage: async (messageId: string, newContent: string) => {
    const { _send, _getMessages } = get();
    if (!_send) return;

    const sessionId = useSessionStore.getState().currentSessionId;
    const messages = _getMessages?.() ?? [];
    const idx = messages.findIndex((m) => m.id === messageId);

    // 真编辑：先把被编辑的用户消息及其后所有消息从会话历史截断，再用新内容重发，
    // 避免旧消息与新消息同时进入模型上下文（"假编辑"会造成上下文双份）。
    if (sessionId && idx >= 0) {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.MESSAGE_TRUNCATE_FROM, sessionId, messageId);
        if (!result.success) {
          toast.error(`编辑失败：${result.error || '无法截断会话历史'}`);
          return;
        }
        useSessionStore.getState().setMessages(messages.slice(0, idx));
      } catch (error) {
        toast.error(`编辑失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    await _send(newContent);
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
