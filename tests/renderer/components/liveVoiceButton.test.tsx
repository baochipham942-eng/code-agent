// @vitest-environment jsdom
//
// LiveVoiceButton 入口门（B1）：可见性（总开关 && Provider 配置 && idle 相位）、
// 空会话直接开、有消息会话先确认。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const bridgeMock = vi.hoisted(() => ({ dial: vi.fn() }));
const availability = vi.hoisted(() => ({ enabled: true, configured: true }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: bridgeMock,
}));
vi.mock('../../../src/renderer/components/features/voice/useVoiceLiveAvailability', () => ({
  useVoiceLiveAvailability: () => availability,
}));

import { LiveVoiceButton } from '../../../src/renderer/components/features/voice/LiveVoiceButton';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

describe('LiveVoiceButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.enabled = true;
    availability.configured = true;
  });
  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('总开关关 / Provider 未配置 / 无会话：不渲染（§9.3）', () => {
    availability.enabled = false;
    const { container, unmount } = render(<LiveVoiceButton sessionId="s1" hasMessages={false} />);
    expect(container.querySelector('[data-testid="live-voice-button"]')).toBeNull();
    unmount();

    availability.enabled = true;
    availability.configured = false;
    const { container: c2 } = render(<LiveVoiceButton sessionId="s1" hasMessages={false} />);
    expect(c2.querySelector('[data-testid="live-voice-button"]')).toBeNull();

    availability.configured = true;
    const { container: c3 } = render(<LiveVoiceButton sessionId={null} hasMessages={false} />);
    expect(c3.querySelector('[data-testid="live-voice-button"]')).toBeNull();
  });

  it('通话进行中不渲染（VoiceChrome 接管底栏）', () => {
    useVoiceCallStore.getState().dialStarted('s1', undefined, 'server_vad');
    const { container } = render(<LiveVoiceButton sessionId="s1" hasMessages={false} />);
    expect(container.querySelector('[data-testid="live-voice-button"]')).toBeNull();
  });

  it('空会话点击直接拨号', () => {
    render(<LiveVoiceButton sessionId="s1" hasMessages={false} />);
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('有消息会话先弹确认，确认后才拨号', () => {
    render(<LiveVoiceButton sessionId="s1" hasMessages={true} />);
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
    expect(screen.getByText(zh.voice.live.confirmMessage)).toBeTruthy();

    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('确认框取消不拨号', () => {
    render(<LiveVoiceButton sessionId="s1" hasMessages={true} />);
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByText(zh.common.cancel));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });

  // ChatInput 在「正在建会话」那段窗口把 disabled 传下来，靠的就是这条：
  // 按钮留在原位置灰，不是消失。它一消失底栏就少一格、旁边全部横移
  // ——2026-07-27 真机「切到新会话时按钮闪变」的其中一半就是这么来的。
  it('disabled 时置灰留在原位，不是整个消失', () => {
    render(<LiveVoiceButton sessionId="s1" hasMessages={false} disabled />);
    const button = screen.getByTestId('live-voice-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('cursor-not-allowed');

    fireEvent.click(button);
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });
});
