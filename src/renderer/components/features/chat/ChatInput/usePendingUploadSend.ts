// ============================================================================
// usePendingUploadSend - 上传期间的提交不丢（FB-579）
// ============================================================================
//
// 缺陷现状：canSubmit 要求 !isUploading（useChatInputSubmit），上传中点发送 /
// 回车被静默吞掉——按钮看着能点，点了却什么都不发生：没有 /api/run、草稿留在
// 输入框、没有任何提示。哪怕是十几字节的文本文件，附件处理也要走一次
// /api/upload/temp 往返（ getPathForFile ），新会话刚建立的几秒里这一往返可能
// 被拖到秒级，静默窗口随之放大。
//
// 这里补「记住这次发送」一档：
// - park：上传中收到提交 → 挂起（草稿原地不动），composer 上提示一行
//   「正在上传，完成后自动发送」；
// - 上传结束且全部文件都读出来了 → 自动重放挂起的提交（新落地的附件一并发出）；
// - 上传结束但有文件没读出来 → 不发、草稿保留、明确告知；
// - 挂起期间用户编辑草稿 / 删附件 / 移除命令 chip → 视为改变主意，挂起作废。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import type { MessageAttachment } from '@shared/contract';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

interface PendingUploadSendSnapshot {
  /** 提交那一刻的草稿文本（trim 后）；重放时原样传回提交函数 */
  content: string;
  /** 提交带 steer（运行中插话）时原样保留 */
  steer?: boolean;
  /** 提交那一刻已落地的附件 id；等待期间少任何一个 = 用户删了附件 → 作废 */
  attachmentIds: string[];
  /** 提交那一刻有没有命令 chip；chip 被移除也视为改变主意 */
  hadPendingCommand: boolean;
}

interface UsePendingUploadSendParams {
  isUploading: boolean;
  /** 本轮上传是否有文件没读出来（processFile/processFolderEntry 返回 null） */
  uploadFailed: boolean;
  /** 与 canSubmit 同口径：disabled 且非 isProcessing 时先压着重放，等能发再放 */
  disabled?: boolean;
  isProcessing?: boolean;
  value: string;
  attachments: MessageAttachment[];
  hasPendingCommand: boolean;
  /** 重放用的提交函数（传 submitWithRuntimeChoice 的最新引用，见 index.tsx） */
  replayRef: React.RefObject<((opts?: { steer?: boolean; content?: string }) => unknown) | null>;
}

/**
 * 上传中的提交挂起器。提交入口（submitWithRuntimeChoice）在 isUploading 时
 * 调 park() 并直接返回；本 hook 三个 effect 负责「作废 / 重放 / 告知」。
 */
export function usePendingUploadSend(params: UsePendingUploadSendParams): {
  /** 有挂起的发送（composer 换「正在上传，完成后自动发送」提示行） */
  pending: boolean;
  /** 上传中收到提交时挂起；草稿为空且无附件无 chip 时不挂（维持原静默行为） */
  park: (opts?: { steer?: boolean; content?: string }) => void;
} {
  const {
    isUploading,
    uploadFailed,
    disabled,
    isProcessing,
    value,
    attachments,
    hasPendingCommand,
    replayRef,
  } = params;
  const { t } = useI18n();
  const [pendingSend, setPendingSend] = useState<PendingUploadSendSnapshot | null>(null);

  const park = useCallback((opts?: { steer?: boolean; content?: string }) => {
    const content = (opts?.content ?? value).trim();
    if (!content && attachments.length === 0 && !hasPendingCommand) return;
    const next: PendingUploadSendSnapshot = {
      content,
      ...(opts?.steer ? { steer: true } : {}),
      attachmentIds: attachments.map((attachment) => attachment.id),
      hadPendingCommand: hasPendingCommand,
    };
    setPendingSend((prev) => (
      // 连点两次 / Enter+点击：同一份草稿只记一次（返回 prev 引用不触发重放）
      prev?.content === next.content
        && Boolean(prev.steer) === Boolean(next.steer)
        && prev.hadPendingCommand === next.hadPendingCommand
        && prev.attachmentIds.length === next.attachmentIds.length
        && prev.attachmentIds.every((id, index) => id === next.attachmentIds[index])
        ? prev
        : next
    ));
  }, [attachments, hasPendingCommand, value]);

  // 挂起期间草稿被编辑（文本变化 / 删了已有附件 / 移除命令 chip）→ 改变主意，作废。
  // 上传落地新增附件不算编辑——那正是我们在等的东西。
  useEffect(() => {
    setPendingSend((pending) => {
      if (!pending) return null;
      if (value.trim() !== pending.content) return null;
      if (hasPendingCommand !== pending.hadPendingCommand) return null;
      const currentIds = new Set(attachments.map((attachment) => attachment.id));
      if (!pending.attachmentIds.every((id) => currentIds.has(id))) return null;
      return pending;
    });
  }, [attachments, hasPendingCommand, value]);

  // 上传结束分流：全部文件读出来了 → 重放挂起的提交；有失败 → 不发并告知。
  // disabled（如正在建会话）且非运行中时先压着，能发时再放。
  useEffect(() => {
    if (isUploading || !pendingSend) return;
    if (disabled && !isProcessing) return;
    setPendingSend(null);
    if (uploadFailed) {
      toast.warning(t.chatInput.pendingSendUploadFailed);
      return;
    }
    replayRef.current?.({
      ...(pendingSend.steer ? { steer: true } : {}),
      content: pendingSend.content,
    });
  }, [disabled, isProcessing, isUploading, pendingSend, replayRef, t, uploadFailed]);

  return { pending: pendingSend !== null, park };
}
