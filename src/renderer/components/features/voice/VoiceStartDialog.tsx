// ============================================================================
// VoiceStartDialog —— 实时通话开场确认（B1）
//
// 旗舰入口的第一触点，不复用通用 ConfirmDialog 的警告框形态（ⓘ + 一行问句
// 视觉上是系统提示，产品负责人 2026-07-26 打回）：品牌色图标 + 「延续上下文」
// 说明 + 隐私小字，主按钮直达「开始通话」。仅已有消息的会话弹出（§4.2）。
// ============================================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, ShieldCheck } from 'lucide-react';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { BUTTON_PRIMARY_CLASS } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';

/**
 * 「不再提示」持久化（现象 1）：localStorage，不进 host 设置结构。
 * 设置页的复原入口不在本批范围——要重置只能清站点数据。
 */
const DISMISS_KEY = 'code-agent:voice-start-dialog-dismissed';

export function isVoiceStartConfirmDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissVoiceStartConfirm(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // localStorage 不可写就只当本次生效，不纠缠
  }
}

export interface VoiceStartDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const VoiceStartDialog: React.FC<VoiceStartDialogProps> = ({ isOpen, onConfirm, onCancel }) => {
  const { t } = useI18n();
  const text = t.voice.live;
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  const handleConfirm = () => {
    if (dontShowAgain) dismissVoiceStartConfirm();
    onConfirm();
  };

  // Modal 用 fixed 定位但不走 portal；本组件挂在 composer 深处，祖先链上有
  // transform（动画容器），fixed 会被劫持成相对该祖先定位——真机实测弹窗底部
  // 超出窗口、按钮不可见（2026-07-26 产品负责人抓到）。portal 到 body 根治。
  return createPortal(
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
          onConfirm={handleConfirm}
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
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(event) => setDontShowAgain(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary-500"
          />
          {text.dontShowAgain}
        </label>
      </div>
    </Modal>,
    document.body,
  );
};

export default VoiceStartDialog;
