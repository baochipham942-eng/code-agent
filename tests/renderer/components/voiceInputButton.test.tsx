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
    partialText: '',
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
    expect(html).toContain('边说边出字');
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

  it('TLS 网络失败（被 host 错标成 SPEECH_NO_CHANNEL）：给网络文案 + 重试，不给「去配置」，不直出英文原文', () => {
    setHookState({
      status: 'error',
      error: 'Client network socket disconnected before secure TLS connection was established',
      errorCode: 'SPEECH_NO_CHANNEL',
      canRetry: false,
    });

    const html = renderButton();

    expect(html).toContain('网络连接失败，请检查网络后重试');
    expect(html).toContain('重试');
    expect(html).not.toContain('去配置语音转文字');
    // 裸英文原文不占主文案（只留在 title tooltip）
    expect(html).not.toContain('<p class="break-words text-xs leading-5 text-zinc-200">Client network socket');
  });

  it('真正的「没有可用通道」（本地化消息）：仍然引导去配置语音转文字', () => {
    setHookState({
      status: 'error',
      error: '语音转文字没有可用通道：本地识别不可用（whisper-cpp 未安装），云端识别未配置 Groq API Key。',
      errorCode: 'SPEECH_NO_CHANNEL',
    });

    const html = renderButton();

    expect(html).toContain('语音转文字没有可用通道');
    expect(html).toContain('去配置语音转文字');
  });

  it('未知错误 + 裸英文技术串：默认档给通用文案 + 重试，不掉进「去配置」', () => {
    setHookState({
      status: 'error',
      error: 'ECONNRESET',
      errorCode: 'TRANSCRIPTION_FAILED',
      canRetry: false,
    });

    const html = renderButton();

    expect(html).toContain('网络连接失败，请检查网络后重试');
    expect(html).toContain('重试');
    expect(html).not.toContain('去配置语音转文字');
  });

  it('未知错误 + 中文消息：通用兜底文案 + 重试', () => {
    setHookState({
      status: 'error',
      error: '转写失败',
      errorCode: 'TRANSCRIPTION_FAILED',
      canRetry: false,
    });

    const html = renderButton();

    expect(html).toContain('语音转文字失败，请重试');
    expect(html).toContain('重试');
    expect(html).not.toContain('去配置语音转文字');
  });

  // ChatInput 在「正在建会话」那段窗口把 disabled 传下来，靠的就是这条：
  // 按钮留在原位置灰，不是消失。它一消失底栏就少一格、旁边全部横移
  // ——2026-07-27 真机「切到新会话时按钮闪变」的其中一半就是这么来的。
  it('disabled 时置灰留在原位，不是整个消失', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputButton, { voice: voiceState, disabled: true }),
    );

    expect(html).toContain('aria-label="语音转文字"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('cursor-not-allowed');
  });
});
