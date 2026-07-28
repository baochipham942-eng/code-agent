// ============================================================================
// VoiceInputButton - 语音输入按钮组件
// 点击录音，录音完成后自动转写
//
// G4 起录音态反馈上移到 composer 输入行（DictationRecordingBar：波形铺满 +
// 计时 + 停止/发送），按钮本体只保留入口/二级停止职责（红底录音态 + tooltip），
// 不再内嵌迷你电平条和底部小计时——那是被点名「反馈层次弱」的旧形态。
// hook 由 ChatInput 持有并以 voice prop 传入（录音条与按钮共享同一路采集状态）。
// ============================================================================

import React from 'react';
import { AlertCircle, Loader2, Mic, RotateCcw, X } from 'lucide-react';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '@shared/contract';
import type { UseVoiceInputReturn } from '../../../../hooks/useVoiceInput';
import { openNativeDesktopSystemSettings } from '../../../../services/nativeDesktop';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { classifyVoiceInputError } from '../../../../utils/voiceInputError';

export interface VoiceInputButtonProps {
  /** ChatInput 持有的语音输入状态（同一 hook 实例驱动录音条与按钮） */
  voice: UseVoiceInputReturn;
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
 */
export const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
  voice,
  disabled = false,
}) => {
  const { t } = useI18n();
  const v = t.voiceInputButton;
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const {
    status,
    duration,
    isSupported,
    isEnabled,
    settings,
    start,
    toggle,
    retry,
    canRetry,
    clearError,
    error,
    errorCode,
    silenceWarning,
  } = voice;

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';
  // 错误分类（现象 8）：host 会把 TLS/网络失败也塞进 SPEECH_NO_CHANNEL，
  // 不能按 code 直接给「去设置」。分类细则见 utils/voiceInputError。
  const errorKind = classifyVoiceInputError(errorCode, error);
  // 主文案只放本地化人话；裸英文技术串只留在 tooltip（title），不占主文案。
  const displayError =
    errorKind === 'network'
      ? v.networkError
      : errorKind === 'unknown'
        ? v.genericError
        : error;
  // 错误卡只留一个「去解决」的落点，落到哪由错误分类决定：麦克风权限 → 系统设置；
  // 配置问题 → 语音输入设置；网络/未知 → 重试（默认档，绝不掉进「去配置」）。
  const fixAction: { label: string; run: () => void } | null =
    errorKind === 'mic-permission'
      ? { label: v.openSettingsButton, run: () => void openNativeDesktopSystemSettings('microphone') }
      : errorKind === 'config'
        ? { label: v.openVoiceSettingsButton, run: () => { clearError(); openSettingsTab('voiceInput'); } }
        // 非流式且有 pendingAudio 时沿用下方 hook 的 retry（重转同一段音频），
        // 这里不再重复给一个重试按钮。
        : canRetry
          ? null
          : { label: v.retryButton, run: () => { clearError(); start(); } };
  const effectiveSettings = settings ?? DEFAULT_SPEECH_INPUT_SETTINGS;

  React.useEffect(() => {
    if (!isSupported || !isEnabled) return;
    const shortcut = effectiveSettings.shortcut?.trim();
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
  }, [disabled, effectiveSettings.shortcut, isEnabled, isSupported, isTranscribing, toggle]);

  // 不支持语音输入时不渲染
  if (!isSupported || !isEnabled) {
    return null;
  }

  const getTitle = () => {
    if (error) return `${v.errorTitlePrefix}${error}`;
    if (isTranscribing) return v.transcribingTitle;
    if (isRecording && silenceWarning) return v.silenceWarningTitle;
    if (isRecording) return `${v.recordingTitlePrefix}${formatDuration(duration)}${v.recordingTitleSuffix}`;
    return v.idleTitle;
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || isTranscribing}
        title={getTitle()}
        aria-label={isRecording ? v.stopRecordingAria : v.idleTitle}
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
      </button>

      {/* 错误恢复 */}
      {status === 'error' && error && (
        <div className="absolute bottom-11 right-0 z-20 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs leading-5 text-zinc-200">{displayError}</p>
              <p className="mt-1 text-2xs text-zinc-500">
                {effectiveSettings.mode === 'stream'
                  ? v.modeStream
                  : effectiveSettings.mode === 'local-first'
                    ? v.modeLocalFirst
                    : effectiveSettings.mode === 'local-only'
                      ? v.modeLocalOnly
                      : v.modeCloudOnly}
                {' · '}
                {effectiveSettings.language === 'auto' ? v.autoLanguage : effectiveSettings.language}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {fixAction && (
              <button
                type="button"
                onClick={fixAction.run}
                className="inline-flex h-7 items-center rounded-md bg-zinc-800 px-2 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                {fixAction.label}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={retry}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-zinc-800 px-2 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                <RotateCcw className="h-3 w-3" />
                {v.retryButton}
              </button>
            )}
            <button
              type="button"
              onClick={clearError}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
              {v.closeButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VoiceInputButton;
