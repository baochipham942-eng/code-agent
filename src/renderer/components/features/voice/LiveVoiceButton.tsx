// ============================================================================
// LiveVoiceButton —— 实时通话正式入口（B1）
//
// 与 VoiceInputButton（口述输入）并列、职责分离（方案 §4.2 / 附录 B）：
// 口述 = 说完转文字进草稿；实时通话 = 全双工通话 + 字幕 + 派活。
// 空会话直接开；已有消息的会话先确认「延续上下文」（B1 产品决议）。
// 通话进行中不渲染（VoiceChrome 接管底栏）。
// ============================================================================

import React, { useState } from 'react';
import { AudioLines } from 'lucide-react';
import { voiceCallBridge } from '../../../services/voiceCallBridge';
import { useVoiceCallStore } from '../../../stores/voiceCallStore';
import { useI18n } from '../../../hooks/useI18n';
import { VoiceStartDialog } from './VoiceStartDialog';
import { useVoiceLiveAvailability } from './useVoiceLiveAvailability';

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
}

export const LiveVoiceButton: React.FC<LiveVoiceButtonProps> = ({ sessionId, hasMessages, disabled, variant = 'ghost' }) => {
  const { t } = useI18n();
  const { enabled, configured } = useVoiceLiveAvailability();
  const phase = useVoiceCallStore((state) => state.phase);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!sessionId || !enabled || !configured || phase !== 'idle') return null;

  const start = () => {
    void voiceCallBridge.dial(sessionId);
  };

  return (
    <>
      <button /* ds-allow:button: 与 VoiceInputButton 同构的纯图标入口按钮，圆形 icon-only 形态沿用既有 composer 按钮语言 */
        type="button"
        data-testid="live-voice-button"
        onClick={() => (hasMessages ? setConfirmOpen(true) : start())}
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
