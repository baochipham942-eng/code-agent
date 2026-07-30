// ============================================================================
// VoiceStartDialog —— 实时语音开场确认（B1）
//
// 旗舰入口的第一触点，不复用通用 ConfirmDialog 的警告框形态（ⓘ + 一行问句
// 视觉上是系统提示，产品负责人 2026-07-26 打回）：品牌色图标 + 「延续上下文」
// 说明 + 隐私小字，主按钮直达「开始通话」。仅已有消息的会话弹出（§4.2）。
// X2：弹层内置音色下拉（拨号前就地选），选项与写路径和设置页同源；
// 通话中热切换（session.update voice）未验证，不在此做。
// ============================================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT, type VoiceTurnDetectionConfig } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import { resolveConversationModelOption } from '@shared/constants/voice';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { BUTTON_PRIMARY_CLASS } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { createLogger } from '../../../utils/logger';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from './voiceSettingsDerivation';

const logger = createLogger('VoiceStartDialog');

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

  // 拨号前就地选音色（X2）：选项与设置页同源（当前通话模型的实测白名单），
  // 写回也走设置页同一条路径（settings set + VOICE_LIVE_SETTINGS_UPDATED_EVENT），
  // 即选即存，两处永不分叉。只在弹层打开时读设置——本组件常驻 composer 树下。
  const [voiceState, setVoiceState] = React.useState<{
    live: VoiceLiveSettings;
    turnDetection: VoiceTurnDetectionConfig | undefined;
  } | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        setVoiceState({
          live: settings.voice?.live ?? {},
          turnDetection: settings.voice?.turnDetection,
        });
      })
      .catch((error) => logger.error('load voice settings failed', error));
    return () => { cancelled = true; };
  }, [isOpen]);

  const conversationModelOption = resolveConversationModelOption(voiceState?.live.conversationModel);
  // 音色与模型强绑定：存量 voiceId 不在当前模型白名单就落到第一个合法值（同 VoiceModelSettings）
  const currentVoiceId = voiceState?.live.voiceId
    && (conversationModelOption.voices as readonly string[]).includes(voiceState.live.voiceId)
    ? voiceState.live.voiceId
    : conversationModelOption.voices[0];

  const persistVoiceId = async (voiceId: string) => {
    if (!voiceState) return;
    const nextLive: VoiceLiveSettings = { ...voiceState.live, voiceId };
    // 运行时真源 turnDetection 与 live 同写，两侧不分叉（契约同 VoiceModelSettings.persistLive）
    const interrupt = deriveInterruptMode({ turnDetection: voiceState.turnDetection, live: nextLive });
    const sensitivity = deriveVadSensitivity({ turnDetection: voiceState.turnDetection, live: nextLive });
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        voice: {
          turnDetection: deriveTurnDetection(interrupt, sensitivity),
          live: nextLive,
        },
      } as Partial<AppSettings>);
      setVoiceState({ ...voiceState, live: nextLive });
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
    } catch (error) {
      logger.error('save voice id failed', error);
    }
  };

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
        {voiceState && (
          <label className="flex items-center justify-between gap-3 text-xs text-zinc-400">
            <span>{t.voice.settings.voiceLabel}</span>
            <select
              data-testid="voice-start-voice-id"
              value={currentVoiceId}
              onChange={(event) => void persistVoiceId(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-primary-500"
            >
              {conversationModelOption.voices.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </label>
        )}
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
