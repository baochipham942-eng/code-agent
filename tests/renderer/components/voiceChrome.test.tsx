// @vitest-environment jsdom
//
// VoiceChrome 七态渲染门：状态文案、静音/结束按钮、PTT 形态按 interruptMode 切换、
// Active Work 条。bridge 换成 mock（真 WS/音频不进单测），状态用真 voiceCallStore。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const bridgeMock = vi.hoisted(() => ({
  hangUp: vi.fn(),
  toggleMute: vi.fn(),
  pttDown: vi.fn(),
  pttUp: vi.fn(),
  manualTap: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: bridgeMock,
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (s: { entries: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ entries: [{ id: 'muzhi', name: '牧之' }] }),
}));
vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => [],
}));

import { VoiceChrome } from '../../../src/renderer/components/features/voice/VoiceChrome';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

function dialInto(mode: 'server_vad' | 'push_to_talk' | 'manual', agentId?: string) {
  useVoiceCallStore.getState().dialStarted('session-1', agentId, mode);
  useVoiceCallStore.getState().phaseChanged('live');
}

describe('VoiceChrome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('idle 不渲染', () => {
    const { container } = render(<VoiceChrome sessionId="session-1" />);
    expect(container.querySelector('[data-testid="voice-chrome"]')).toBeNull();
  });

  it('listening 态：文案 + data-state + 无 PTT（server_vad）', () => {
    dialInto('server_vad');
    render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('listening');
    expect(screen.getByTestId('voice-status').textContent).toBe(zh.voice.status.listening);
    expect(screen.queryByTestId('voice-ptt')).toBeNull();
    expect(screen.queryByTestId('voice-manual-commit')).toBeNull();
  });

  it('connecting / speaking / working / muted / error 各态文案正确', () => {
    const store = useVoiceCallStore.getState();
    store.dialStarted('session-1', undefined, 'server_vad');
    const { rerender } = render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('connecting');
    expect(screen.getByTestId('voice-status').textContent).toBe(zh.voice.status.connecting);

    store.phaseChanged('live');
    store.eventApplied({ assistantSpeaking: true });
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('speaking');

    store.eventApplied({ assistantSpeaking: false, workItem: { id: 'w1', title: '写测例', status: 'queued' } });
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('working');
    expect(screen.getByTestId('voice-work-item-queued').textContent).toContain('写测例');

    store.muteChanged(true);
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('muted');

    store.phaseChanged('error');
    store.eventApplied({ error: { code: 'X', message: 'VOICE_UPSTREAM_UNAVAILABLE' } });
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('error');
    expect(screen.getByTestId('voice-status').textContent).toBe('VOICE_UPSTREAM_UNAVAILABLE');
  });

  it('静音与结束按钮调 bridge', () => {
    dialInto('server_vad');
    render(<VoiceChrome sessionId="session-1" />);
    fireEvent.click(screen.getByTestId('voice-mute'));
    expect(bridgeMock.toggleMute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('voice-end'));
    expect(bridgeMock.hangUp).toHaveBeenCalledTimes(1);
  });

  it('push_to_talk：按住/松开走 pttDown/pttUp', () => {
    dialInto('push_to_talk');
    render(<VoiceChrome sessionId="session-1" />);
    const ptt = screen.getByTestId('voice-ptt');
    expect(ptt.textContent).toBe(zh.voice.live.holdToTalk);
    fireEvent.pointerDown(ptt);
    expect(bridgeMock.pttDown).toHaveBeenCalledTimes(1);
    useVoiceCallStore.getState().pttCaptureChanged(true);
    fireEvent.pointerUp(ptt);
    expect(bridgeMock.pttUp).toHaveBeenCalledTimes(1);
  });

  it('manual：点按走 manualTap', () => {
    dialInto('manual');
    render(<VoiceChrome sessionId="session-1" />);
    fireEvent.click(screen.getByTestId('voice-manual-commit'));
    expect(bridgeMock.manualTap).toHaveBeenCalledTimes(1);
  });

  it('ActiveExpertChip：单专家显示「与 {花名} 通话」，无专家显示默认助手', () => {
    dialInto('server_vad', 'muzhi');
    const { unmount } = render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-active-expert').textContent).toBe('与 牧之 通话');
    unmount();

    useVoiceCallStore.getState().reset();
    dialInto('server_vad');
    render(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-active-expert').textContent).toBe(zh.voice.expert.default_assistant);
  });
});
