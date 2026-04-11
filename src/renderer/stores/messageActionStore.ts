// ============================================================================
// MessageAction Store - Edit & Regenerate message actions
// ============================================================================
// Lightweight store that decouples message action UI (in MessageBubble)
// from the send logic (in ChatView/useAgent).
// ChatView registers the sender; MessageBubble consumes it.
// ============================================================================

import { create } from 'zustand';
import type { Message } from '@shared/types';

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
}));
