/**
 * composer 里「失败气泡编辑重发」和「改排队消息」互斥。
 * 同时开着时，提交会被队列更新分支截获，把另一条排队消息覆盖成失败草稿。
 */
type ComposerEditMode =
  | { kind: 'idle' }
  | { kind: 'failed-resend'; clientMessageId: string }
  | { kind: 'queued-edit'; queuedInputId: string };

export function composerEditModeState(mode: ComposerEditMode): {
  editingQueuedInputId: string | null;
  pendingResendClientMessageId: string | null;
} {
  if (mode.kind === 'failed-resend') {
    return {
      editingQueuedInputId: null,
      pendingResendClientMessageId: mode.clientMessageId,
    };
  }
  if (mode.kind === 'queued-edit') {
    return {
      editingQueuedInputId: mode.queuedInputId,
      pendingResendClientMessageId: null,
    };
  }
  return { editingQueuedInputId: null, pendingResendClientMessageId: null };
}
