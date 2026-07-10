import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../src/shared/contract';

const { hookState } = vi.hoisted(() => ({
  hookState: {
    current: null as any,
  },
}));

vi.mock('../../../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => hookState.current,
}));

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  openNativeDesktopSystemSettings: vi.fn(),
}));

import { VoiceInputButton } from '../../../src/renderer/components/features/chat/ChatInput/VoiceInputButton';

function setHookState(patch: Record<string, unknown> = {}) {
  hookState.current = {
    status: 'idle',
    duration: 0,
    isSupported: true,
    isEnabled: true,
    settings: DEFAULT_SPEECH_INPUT_SETTINGS,
    toggle: vi.fn(),
    retry: vi.fn(),
    canRetry: false,
    clearError: vi.fn(),
    error: null,
    errorCode: null,
    inputLevel: 0,
    silenceWarning: false,
    ...patch,
  };
}

function renderButton(): string {
  return renderToStaticMarkup(
    React.createElement(VoiceInputButton, {
      onTranscript: () => undefined,
    }),
  );
}

describe('VoiceInputButton', () => {
  beforeEach(() => {
    setHookState();
  });

  it('renders the idle composer voice entry point', () => {
    const html = renderButton();

    expect(html).toContain('aria-label="开始语音输入，首次使用会请求麦克风"');
    expect(html).toContain('title="开始语音输入，首次使用会请求麦克风"');
  });

  it('keeps recording feedback inside the button surface', () => {
    setHookState({
      status: 'recording',
      duration: 12,
      inputLevel: 0.42,
    });

    const html = renderButton();

    expect(html).toContain('aria-label="停止录音并转写"');
    expect(html).toContain('录音中 12s，点击停止');
    expect(html).toContain('width:42%');
    expect(html).toContain('12s');
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
