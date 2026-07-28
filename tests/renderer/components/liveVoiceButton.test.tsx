// @vitest-environment jsdom
//
// LiveVoiceButton 入口门（B1）：可见性（总开关 && Provider 配置 && idle 相位）、
// 空会话直接开、有消息会话先确认。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const bridgeMock = vi.hoisted(() => ({ dial: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: bridgeMock,
}));

import { LiveVoiceButton, type LiveVoiceButtonProps } from '../../../src/renderer/components/features/voice/LiveVoiceButton';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

const AVAILABLE: LiveVoiceButtonProps['availability'] = { enabled: true, configured: true };

function renderButton(props: Partial<LiveVoiceButtonProps> = {}) {
  return render(
    <LiveVoiceButton sessionId="s1" hasMessages={false} availability={AVAILABLE} {...props} />,
  );
}

describe('LiveVoiceButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('总开关关 / Provider 未配置 / 无会话：不渲染（§9.3）', () => {
    const { container, unmount } = renderButton({ availability: { enabled: false, configured: true } });
    expect(container.querySelector('[data-testid="live-voice-button"]')).toBeNull();
    unmount();

    const { container: c2, unmount: u2 } = renderButton({ availability: { enabled: true, configured: false } });
    expect(c2.querySelector('[data-testid="live-voice-button"]')).toBeNull();
    u2();

    const { container: c3 } = renderButton({ sessionId: null });
    expect(c3.querySelector('[data-testid="live-voice-button"]')).toBeNull();
  });

  it('通话进行中不渲染（VoiceChrome 接管底栏）', () => {
    useVoiceCallStore.getState().dialStarted('s1', undefined, 'server_vad');
    const { container } = renderButton();
    expect(container.querySelector('[data-testid="live-voice-button"]')).toBeNull();
  });

  it('空会话点击直接拨号', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('有消息会话先弹确认，确认后才拨号', () => {
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
    expect(screen.getByText(zh.voice.live.confirmMessage)).toBeTruthy();

    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('确认框取消不拨号', () => {
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByText(zh.common.cancel));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });

  it('勾选「不再提示」并确认后：写 localStorage，之后拨号直接进通话不再弹框（现象 1）', () => {
    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');

    const { unmount } = renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByLabelText(zh.voice.live.dontShowAgain));
    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(window.localStorage.getItem('code-agent:voice-start-dialog-dismissed')).toBe('1');
    unmount();

    // 第二次拨号：不弹确认框，直接 dial
    bridgeMock.dial.mockClear();
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(screen.queryByText(zh.voice.live.confirmMessage)).toBeNull();

    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');
  });

  it('不勾选「不再提示」：确认后照常拨号但不写 localStorage', () => {
    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(window.localStorage.getItem('code-agent:voice-start-dialog-dismissed')).toBeNull();
  });

  // ChatInput 在「正在建会话」那段窗口把 disabled 传下来，靠的就是这条：
  // 按钮留在原位置灰，不是消失。它一消失底栏就少一格、旁边全部横移
  // ——2026-07-27 真机「切到新会话时按钮闪变」的其中一半就是这么来的。
  it('disabled 时置灰留在原位，不是整个消失', () => {
    renderButton({ disabled: true });
    const button = screen.getByTestId('live-voice-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('cursor-not-allowed');

    fireEvent.click(button);
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });
});
