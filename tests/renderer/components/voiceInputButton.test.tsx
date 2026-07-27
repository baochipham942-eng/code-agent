import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../src/shared/contract';
import type { UseVoiceInputReturn } from '../../../src/renderer/hooks/useVoiceInput';

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  openNativeDesktopSystemSettings: vi.fn(),
}));

import { VoiceInputButton } from '../../../src/renderer/components/features/chat/ChatInput/VoiceInputButton';

let voiceState: UseVoiceInputReturn;

function setHookState(patch: Record<string, unknown> = {}) {
  voiceState = {
    status: 'idle',
    duration: 0,
    isSupported: true,
    isEnabled: true,
    settings: DEFAULT_SPEECH_INPUT_SETTINGS,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    retry: vi.fn(),
    canRetry: false,
    clearError: vi.fn(),
    error: null,
    errorCode: null,
    lastResult: null,
    inputLevel: 0,
    silenceWarning: false,
    ...patch,
  } as UseVoiceInputReturn;
}

function renderButton(): string {
  return renderToStaticMarkup(
    React.createElement(VoiceInputButton, {
      voice: voiceState,
    }),
  );
}

describe('VoiceInputButton', () => {
  beforeEach(() => {
    setHookState();
  });

  it('renders the idle composer voice entry point', () => {
    const html = renderButton();

    expect(html).toContain('aria-label="语音转文字"');
    expect(html).toContain('title="语音转文字"');
  });

  it('recording state keeps only the stop entry — feedback lives in the composer recording bar (G4)', () => {
    setHookState({
      status: 'recording',
      duration: 12,
      inputLevel: 0.42,
    });

    const html = renderButton();

    expect(html).toContain('aria-label="停止录音并转写"');
    expect(html).toContain('录音中 12s，点击停止');
    expect(html).toContain('bg-red-500');
    // G4：迷你电平条/底部小计时已上移到 DictationRecordingBar，按钮不再内嵌
    expect(html).not.toContain('width:42%');
  });

  it('shows a low-audio warning without opening an error popover', () => {
    setHookState({
      status: 'recording',
      duration: 4,
      silenceWarning: true,
    });

    const html = renderButton();

    expect(html).toContain('未检测到明显语音，请检查麦克风输入');
    expect(html).toContain('bg-amber-500');
    expect(html).not.toContain('重试');
  });

  it('shows transcribing as a disabled in-progress state', () => {
    setHookState({
      status: 'transcribing',
    });

    const html = renderButton();

    expect(html).toContain('正在识别…');
    expect(html).toContain('cursor-not-allowed');
  });

  it('shows recoverable transcription failure actions', () => {
    setHookState({
      status: 'error',
      error: '模型文件不存在',
      errorCode: 'NOT_INITIALIZED',
      canRetry: true,
    });

    const html = renderButton();

    expect(html).toContain('模型文件不存在');
    expect(html).toContain('本地优先');
    expect(html).toContain('重试');
    expect(html).toContain('关闭');
  });

  it('links microphone permission failures to system settings', () => {
    setHookState({
      status: 'error',
      error: '请允许麦克风权限',
      errorCode: 'MICROPHONE_PERMISSION_DENIED',
    });

    const html = renderButton();

    expect(html).toContain('请允许麦克风权限');
    expect(html).toContain('打开设置');
  });
});
