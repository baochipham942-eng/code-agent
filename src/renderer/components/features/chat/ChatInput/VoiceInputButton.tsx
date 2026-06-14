// ============================================================================
// VoiceInputButton - 语音输入按钮组件
// 点击录音，录音完成后自动转写
// ============================================================================

import React from 'react';
import { AlertCircle, Loader2, Mic, RotateCcw, X } from 'lucide-react';
import type { SpeechTranscribeResult } from '@shared/contract';
import { useVoiceInput } from '../../../../hooks/useVoiceInput';
import { openNativeDesktopSystemSettings } from '../../../../services/nativeDesktop';

export interface VoiceInputButtonProps {
  /** 转写完成回调 */
  onTranscript: (text: string, result?: SpeechTranscribeResult) => void;
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

function normalizeShortcutPart(part: string): string {
  return part.trim().toLowerCase();
}

function keyMatches(event: KeyboardEvent, key: string): boolean {
  if (key === 'space') return event.code === 'Space';
  if (key.length === 1) return event.key.toLowerCase() === key;
  return event.key.toLowerCase() === key || event.code.toLowerCase() === key;
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+').map(normalizeShortcutPart).filter(Boolean);
  if (parts.length === 0) return false;

  const key = parts.find((part) => !['cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift', 'mod'].includes(part));
  if (!key) return false;

  const wantsMod = parts.includes('mod');
  const wantsCmd = wantsMod || parts.includes('cmd') || parts.includes('command');
  const wantsCtrl = wantsMod || parts.includes('ctrl') || parts.includes('control');
  const isMac = navigator.platform.toLowerCase().includes('mac');

  if (wantsMod) {
    if (isMac ? !event.metaKey : !event.ctrlKey) return false;
  } else {
    if (event.metaKey !== wantsCmd) return false;
    if (event.ctrlKey !== wantsCtrl) return false;
  }

  if (event.altKey !== (parts.includes('alt') || parts.includes('option'))) return false;
  if (event.shiftKey !== parts.includes('shift')) return false;
  return keyMatches(event, key);
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
    isEnabled,
    settings,
    toggle,
    retry,
    canRetry,
    clearError,
    error,
    errorCode,
    inputLevel,
    silenceWarning,
  } = useVoiceInput({
    onTranscript,
  });

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';
  const canOpenMicrophoneSettings = errorCode === 'MICROPHONE_PERMISSION_DENIED';

  React.useEffect(() => {
    if (!isSupported || !isEnabled) return;
    const shortcut = settings.shortcut?.trim();
    if (!shortcut) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || disabled || isTranscribing) return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [disabled, isEnabled, isSupported, isTranscribing, settings.shortcut, toggle]);

  // 不支持语音输入时不渲染
  if (!isSupported || !isEnabled) {
    return null;
  }

  const getTitle = () => {
    if (error) return `错误: ${error}`;
    if (isTranscribing) return '正在识别...';
    if (isRecording && silenceWarning) return '未检测到明显语音，请检查麦克风输入';
    if (isRecording) return `录音中 ${formatDuration(duration)}，点击停止`;
    return '语音输入';
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || isTranscribing}
        title={getTitle()}
        aria-label={isRecording ? '停止录音' : '开始语音输入'}
        className={`relative flex-shrink-0 w-9 h-9 overflow-hidden rounded-xl flex items-center justify-center transition-all duration-300 ${
          isRecording
            ? silenceWarning
              ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/25'
              : 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/30'
            : isTranscribing
              ? 'bg-primary-500 text-white'
              : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700'
        } ${(disabled || isTranscribing) ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {isTranscribing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Mic
            className={`w-4 h-4 transition-all ${
              isRecording ? 'text-white animate-pulse' : ''
            }`}
          />
        )}
        {isRecording && (
          <span className="absolute bottom-1 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-white/25">
            <span
              className="block h-full rounded-full bg-white transition-[width] duration-100"
              style={{ width: `${Math.max(8, Math.round(inputLevel * 100))}%` }}
            />
          </span>
        )}
      </button>

      {/* 错误恢复 */}
      {status === 'error' && error && (
        <div className="absolute bottom-11 right-0 z-20 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs leading-5 text-zinc-200">{error}</p>
              <p className="mt-1 text-2xs text-zinc-500">
                {settings.mode === 'local-first' ? '本地优先' : settings.mode === 'local-only' ? '仅本地' : '仅云端'}
                {' · '}
                {settings.language === 'auto' ? '自动语言' : settings.language}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {canOpenMicrophoneSettings && (
              <button
                type="button"
                onClick={() => void openNativeDesktopSystemSettings('microphone')}
                className="inline-flex h-7 items-center rounded-md bg-zinc-800 px-2 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                打开设置
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={retry}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-zinc-800 px-2 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                <RotateCcw className="h-3 w-3" />
                重试
              </button>
            )}
            <button
              type="button"
              onClick={clearError}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
              关闭
            </button>
          </div>
        </div>
      )}

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
