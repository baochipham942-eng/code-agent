// ============================================================================
// LiveVoiceButton —— 实时通话正式入口（B1）
//
// 与 VoiceInputButton（口述输入）并列、职责分离（方案 §4.2 / 附录 B）：
// 口述 = 说完转文字进草稿；实时通话 = 全双工通话 + 字幕 + 派活。
// 空会话直接开；已有消息的会话先确认「延续上下文」（B1 产品决议）。
// 通话进行中不渲染（VoiceChrome 接管底栏）。
//
// 缺 key 降级（2026-07-30，能力不可用要降级提示不是消失）：总开关开着但没配
// DashScope key 时，按钮不消失，降级成同位置同尺寸的弱化引导态——点击不拨号，
// 弹引导层指向设置 → 语音「实时语音」tab（那里可以就地配 key）。
// 总开关关掉（enabled === false）是用户明确不要，保持不渲染。
// ============================================================================

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines } from 'lucide-react';
import { voiceCallBridge } from '../../../services/voiceCallBridge';
import { useVoiceCallStore } from '../../../stores/voiceCallStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { BUTTON_PRIMARY_CLASS } from '../../primitives/Button';
import { VoiceStartDialog, isVoiceStartConfirmDismissed } from './VoiceStartDialog';

export interface LiveVoiceButtonProps {
  sessionId: string | null;
  /** 已有文字消息的会话要先确认延续上下文 */
  hasMessages: boolean;
  disabled?: boolean;
  /**
   * `primary` = 它占的是输入框右侧主按钮那个位置（输入框空着时接替发送键）。
   * 那个位置的按钮是这一行的视觉落点，用弱色 icon-only 会让整行没有终点。
   */
  variant?: 'ghost' | 'primary';
  /**
   * 可见性前提（设置总开关 + Provider 已配置），由 ChatInput 的单一
   * useVoiceLiveAvailability 实例传入。曾经组件内部各自再调一次这个 hook——
   * 两个实例的异步解析结果会短暂不一致：父层已判定「语音占主位」而按钮内部
   * 还没拿到 configured，于是 return null，主按钮位整格空掉（没有发送键兜底），
   * 要等下一次无关的重渲染（hover/聚焦）才补上——真机「按钮 hover 才出现」。
   */
  availability: { enabled: boolean; configured: boolean };
}

export const LiveVoiceButton: React.FC<LiveVoiceButtonProps> = ({ sessionId, hasMessages, disabled, variant = 'ghost', availability }) => {
  const { t } = useI18n();
  const { enabled, configured } = availability;
  const phase = useVoiceCallStore((state) => state.phase);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  // enabled === false（用户明确关掉总开关）不纠缠，保持不渲染；
  // configured === false 走下面的降级引导态，不在这里拦。
  if (!sessionId || !enabled || phase !== 'idle') return null;

  // 缺 key 降级引导态：同位置同尺寸，弱化视觉 + 角标；点击不拨号，弹引导层。
  if (!configured) {
    const text = t.voice.live;
    return (
      <>
        <button /* ds-allow:button: 与正常态同位置同尺寸（w-9 h-9 icon-only）的降级引导入口，弱化视觉 + 缺 key 角标，沿用既有 composer 按钮语言 */
          type="button"
          data-testid="live-voice-button-unconfigured"
          onClick={() => setGuideOpen(true)}
          title={text.noKeyButtonTitle}
          aria-label={text.noKeyButtonTitle}
          className={`relative flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${
            variant === 'primary'
              ? 'bg-zinc-800/60 text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-400'
              : 'text-zinc-600 hover:text-zinc-500 hover:bg-zinc-800'
          }`}
        >
          <AudioLines className="w-4 h-4" />
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
        </button>

        {/* 引导层挂 portal 到 body：同 VoiceStartDialog 的教训，composer 祖先链上有
            transform，fixed 会被劫持成相对祖先定位。 */}
        {guideOpen && createPortal(
          <Modal
            isOpen={guideOpen}
            onClose={() => setGuideOpen(false)}
            size="sm"
            showCloseButton={false}
            footer={
              <ModalFooter
                cancelText={t.common.cancel}
                confirmText={text.noKeyAction}
                onCancel={() => setGuideOpen(false)}
                onConfirm={() => {
                  setGuideOpen(false);
                  openSettingsTab('voiceModel');
                }}
                confirmColorClass={BUTTON_PRIMARY_CLASS}
              />
            }
          >
            <div data-testid="voice-nokey-guide" className="flex flex-col gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-500/10 text-primary-400">
                <AudioLines className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-base font-semibold text-zinc-100">{text.noKeyTitle}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{text.noKeyMessage}</p>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
      </>
    );
  }

  const start = () => {
    void voiceCallBridge.dial(sessionId);
  };

  return (
    <>
      <button /* ds-allow:button: 与 VoiceInputButton 同构的纯图标入口按钮，圆形 icon-only 形态沿用既有 composer 按钮语言 */
        type="button"
        data-testid="live-voice-button"
        onClick={() => (hasMessages && !isVoiceStartConfirmDismissed() ? setConfirmOpen(true) : start())}
        disabled={disabled}
        title={t.voice.live.startTitle}
        aria-label={t.voice.live.startTitle}
        className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${
          variant === 'primary'
            ? 'bg-zinc-700/70 text-zinc-200 hover:bg-zinc-600'
            : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <AudioLines className="w-4 h-4" />
      </button>

      <VoiceStartDialog
        isOpen={confirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          start();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
};

export default LiveVoiceButton;
