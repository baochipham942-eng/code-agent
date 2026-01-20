// ============================================================================
// VoiceInputButton - 语音输入按钮组件
// 点击录音，录音完成后自动转写
// ============================================================================

import React from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { IconButton } from '../../../primitives';
import { useVoiceInput, VoiceInputStatus } from '../../../../hooks/useVoiceInput';

export interface VoiceInputButtonProps {
  /** 转写完成回调 */
  onTranscript: (text: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

/**
 * 格式化录音时长
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
}

/**
 * 语音输入按钮
 *
 * 点击开始录音，再次点击停止录音并自动转写
 * 支持录音中动画、转写中加载状态
 */
export const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
  onTranscript,
  disabled = false,
}) => {
  const {
    status,
    duration,
    isSupported,
    toggle,
    error,
  } = useVoiceInput({
    onTranscript,
    maxDuration: 60,
  });

  // 不支持语音输入时不渲染
  if (!isSupported) {
    return null;
  }

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';
  const isActive = isRecording || isTranscribing;

  const getTitle = () => {
    if (error) return `错误: ${error}`;
    if (isTranscribing) return '正在识别...';
    if (isRecording) return `录音中 ${formatDuration(duration)}，点击停止`;
    return '语音输入';
  };

  return (
    <div className="relative">
      <IconButton
        icon={
          isTranscribing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Mic
              className={`w-5 h-5 transition-all ${
                isRecording ? 'text-white animate-pulse' : ''
              }`}
            />
          )
        }
        aria-label={isRecording ? '停止录音' : '开始语音输入'}
        title={getTitle()}
        onClick={toggle}
        disabled={disabled || isTranscribing}
        variant="ghost"
        size="lg"
        className={`flex-shrink-0 !rounded-xl transition-all duration-300 ${
          isRecording
            ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/30'
            : isTranscribing
              ? 'bg-primary-500 text-white'
              : ''
        } ${(disabled || isTranscribing) ? 'opacity-50 cursor-not-allowed' : ''}`}
      />


      {/* 录音时长显示 */}
      {isRecording && duration > 0 && (
        <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-2xs text-red-400 font-mono whitespace-nowrap">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
};

export default VoiceInputButton;
