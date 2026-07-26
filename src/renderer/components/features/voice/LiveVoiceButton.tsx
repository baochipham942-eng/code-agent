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
import { ConfirmDialog } from '../../composites/ConfirmDialog';
import { useVoiceLiveAvailability } from './useVoiceLiveAvailability';

export interface LiveVoiceButtonProps {
  sessionId: string | null;
  /** 已有文字消息的会话要先确认延续上下文 */
  hasMessages: boolean;
  disabled?: boolean;
}

export const LiveVoiceButton: React.FC<LiveVoiceButtonProps> = ({ sessionId, hasMessages, disabled }) => {
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
      <button
        type="button"
        data-testid="live-voice-button"
        onClick={() => (hasMessages ? setConfirmOpen(true) : start())}
        disabled={disabled}
        title={t.voice.live.startTitle}
        aria-label={t.voice.live.startTitle}
        className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700 ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
      >
        <AudioLines className="w-4 h-4" />
      </button>

      <ConfirmDialog
        isOpen={confirmOpen}
        title={t.voice.live.confirmTitle}
        message={t.voice.live.confirmMessage}
        variant="info"
        confirmText={t.voice.live.confirmAction}
        cancelText={t.common.cancel}
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
