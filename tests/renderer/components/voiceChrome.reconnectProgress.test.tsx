// @vitest-environment jsdom
// F2 重连进度门：重连中通话条要告诉用户「第 N 次 / 共 M 次」，M 必须等于退避表长度。
// bridge 用 mock，状态走真实 voiceCallStore（同 voiceChrome.test.tsx 先例）。
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RECONNECT_BACKOFF_MS } from '@shared/constants/voice';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: { hangUp: vi.fn(), toggleMute: vi.fn(), manualTap: vi.fn() },
}));

import { VoiceChrome } from '../../../src/renderer/components/features/voice/VoiceChrome';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

const MAX_ATTEMPTS = VOICE_RECONNECT_BACKOFF_MS.length;

function progressText(attempt: number): string {
  return zh.voice.status.reconnectingProgress
    .replace('{n}', String(attempt))
    .replace('{m}', String(MAX_ATTEMPTS));
}

/** 模拟 bridge 的断线重连：live 中连接断开，开始第 attempt 次重连。 */
function enterReconnecting(attempt: number) {
  const store = useVoiceCallStore.getState();
  store.dialStarted('session-1', 'lanxi', 'server_vad');
  store.phaseChanged('live');
  store.reconnectingChanged(true, { attempt, maxAttempts: MAX_ATTEMPTS });
  store.phaseChanged('connecting');
}

const ON_CALL_REGEX = /^通话中 \d{2}:\d{2}$/;

describe('VoiceChrome 重连进度（F2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('重连中：通话条显示「第 N 次 · 最多 M 次」，M 等于退避表长度', () => {
    enterReconnecting(2);
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('reconnecting');
    // 文案由 i18n 模板 + store 进度拼出；断言不写真值数字，只和常量与模板比。
    expect(screen.getByTestId('voice-status').textContent).toBe(progressText(2));
    expect(useVoiceCallStore.getState().reconnectAttempt).toBe(2);
    expect(useVoiceCallStore.getState().reconnectMaxAttempts).toBe(MAX_ATTEMPTS);
  });

  it('重连进度随次数推进：第 1 次与最后一次文案不同', () => {
    enterReconnecting(1);
    const { unmount } = render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-status').textContent).toBe(progressText(1));
    unmount();

    useVoiceCallStore.getState().reset();
    enterReconnecting(MAX_ATTEMPTS);
    render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-status').textContent).toBe(progressText(MAX_ATTEMPTS));
  });

  it('重连成功：进度清零，状态回到“通话中 mm:ss”', () => {
    enterReconnecting(2);
    render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-status').textContent).toBe(progressText(2));

    act(() => {
      useVoiceCallStore.getState().reconnectingChanged(false);
      useVoiceCallStore.getState().phaseChanged('live');
    });

    const state = useVoiceCallStore.getState();
    expect(state.reconnectAttempt).toBe(0);
    expect(state.reconnectMaxAttempts).toBe(0);
    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expect(screen.getByTestId('voice-status').textContent).not.toContain('重试');
  });

  it('重试耗尽：显示 RECONNECT_FAILED 文案，不再显示进度', () => {
    enterReconnecting(MAX_ATTEMPTS);
    render(<VoiceChrome sessionId="session-1" />);

    const store = useVoiceCallStore.getState();
    act(() => {
      store.phaseChanged('error');
      store.eventApplied({
        error: { code: 'RECONNECT_FAILED', message: 'reconnect exhausted' },
      });
    });

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('error');
    // 按 code 查 i18n，不是 host 原文（同 voiceChrome.test.tsx 的断言风格）。
    expect(screen.getByTestId('voice-status').textContent).toBe(zh.voice.messageByCode.RECONNECT_FAILED);
    expect(screen.getByTestId('voice-status').textContent).not.toContain('重试');
  });
});
