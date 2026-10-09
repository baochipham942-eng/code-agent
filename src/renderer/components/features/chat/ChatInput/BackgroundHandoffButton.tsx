// ============================================================================
// BackgroundHandoffButton - 「转后台继续聊」次级操作（运行中 composer 第三个显式入口）
// ============================================================================
//
// 只在「会话正在跑 + 草稿非空」时出现，紧挨发送按钮；点击动作在 useBackgroundHandoffSubmit
// （转后台 → 开新会话 → 草稿普通发送）。不占核心操作区（resolveComposerCoreActions 的
// 两个同级位），也不新增默认键位。

import React from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';

/** 可见性单真源（纯函数）：正在跑 + 有可发草稿 + 有会话 + 不在队列编辑态。 */
function resolveBackgroundHandoffVisible(params: {
  isProcessing: boolean;
  draftText: string;
  attachmentCount: number;
  sessionId: string | null;
  editingQueuedInput: boolean;
}): boolean {
  return params.isProcessing
    && (params.draftText.trim().length > 0 || params.attachmentCount > 0)
    && params.sessionId !== null
    && !params.editingQueuedInput;
}

export interface BackgroundHandoffButtonProps {
  isProcessing: boolean;
  draftText: string;
  attachmentCount: number;
  sessionId: string | null;
  editingQueuedInput: boolean;
  onTrigger: () => void;
}

export const BackgroundHandoffButton: React.FC<BackgroundHandoffButtonProps> = ({
  isProcessing,
  draftText,
  attachmentCount,
  sessionId,
  editingQueuedInput,
  onTrigger,
}) => {
  const { t } = useI18n();
  if (!resolveBackgroundHandoffVisible({ isProcessing, draftText, attachmentCount, sessionId, editingQueuedInput })) {
    return null;
  }
  return (
    <button
      type="button"
      data-testid="background-handoff-button"
      onClick={onTrigger}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-200 focus-visible:outline-hidden"
      aria-label={t.chatInput.backgroundHandoffAria}
      title={t.chatInput.backgroundHandoffLabel}
    >
      <ArrowDownToLine className="h-3.5 w-3.5" />
      <span>{t.chatInput.backgroundHandoffLabel}</span>
    </button>
  );
};
