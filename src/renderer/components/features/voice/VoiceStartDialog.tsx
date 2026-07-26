// ============================================================================
// VoiceStartDialog —— 实时通话开场确认（B1）
//
// 旗舰入口的第一触点，不复用通用 ConfirmDialog 的警告框形态（ⓘ + 一行问句
// 视觉上是系统提示，产品负责人 2026-07-26 打回）：品牌色图标 + 「延续上下文」
// 说明 + 隐私小字，主按钮直达「开始通话」。仅已有消息的会话弹出（§4.2）。
// ============================================================================

import React from 'react';
import { AudioLines, ShieldCheck } from 'lucide-react';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { BUTTON_PRIMARY_CLASS } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';

export interface VoiceStartDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const VoiceStartDialog: React.FC<VoiceStartDialogProps> = ({ isOpen, onConfirm, onCancel }) => {
  const { t } = useI18n();
  const text = t.voice.live;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="sm"
      showCloseButton={false}
      footer={
        <ModalFooter
          cancelText={t.common.cancel}
          confirmText={text.confirmAction}
          onCancel={onCancel}
          onConfirm={onConfirm}
          confirmColorClass={BUTTON_PRIMARY_CLASS}
        />
      }
    >
      <div data-testid="voice-start-dialog" className="flex flex-col gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-500/10 text-primary-400">
          <AudioLines className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{text.confirmTitle}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{text.confirmMessage}</p>
        </div>
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-zinc-500">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{text.confirmPrivacy}</span>
        </p>
      </div>
    </Modal>
  );
};

export default VoiceStartDialog;
