// @vitest-environment jsdom
// VoiceChrome C 方案七态行为门。bridge 用 mock，状态走真实 voiceCallStore。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const bridgeMock = vi.hoisted(() => ({
  hangUp: vi.fn(),
  toggleMute: vi.fn(),
  manualTap: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: bridgeMock,
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: { entries: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ entries: [{ id: 'lanxi', name: '岚析' }] }),
}));
vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => [],
}));

import { VoiceChrome } from '../../../src/renderer/components/features/voice/VoiceChrome';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

function dialInto(mode: 'server_vad' | 'manual' = 'server_vad', agentId = 'lanxi') {
  useVoiceCallStore.getState().dialStarted('session-1', agentId, mode);
  useVoiceCallStore.getState().phaseChanged('live');
}

function chromeButtons(): HTMLButtonElement[] {
  return Array.from(screen.getByTestId('voice-chrome').querySelectorAll('button'));
}

function expectAtMostTwoActions(): void {
  expect(chromeButtons().length).toBeLessThanOrEqual(2);
}

describe('VoiceChrome C 方案', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
    vi.useRealTimers();
  });

  it('idle 不渲染', () => {
    const { container } = render(<VoiceChrome sessionId="session-1" />);
    expect(container.querySelector('[data-testid="voice-chrome"]')).toBeNull();
  });

  it('连接中：渐变球、状态与对象可见，麦克风留位但 disabled，操作数为 2', () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'lanxi', 'server_vad');
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('connecting');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('connecting');
    expect(screen.getByTestId('voice-status').textContent).toBe('正在接通…');
    expect(screen.getByTestId('voice-meta').textContent).toBe('岚析');
    expect(screen.getByTestId('voice-mute').hasAttribute('disabled')).toBe(true);
    expectAtMostTwoActions();
  });

  it('正在听：麦克风激活，通话时长按秒更新，操作数为 2', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00+08:00'));
    dialInto();
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-status').textContent).toBe('正在听');
    expect(screen.getByTestId('voice-meta').textContent).toBe('岚析 · 00:00');
    expect(screen.getByTestId('voice-mute').hasAttribute('disabled')).toBe(false);
    expectAtMostTwoActions();

    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByTestId('voice-meta').textContent).toBe('岚析 · 01:01');
  });

  it('正在回答：青白快呼吸球与回答文案，操作数为 2', () => {
    dialInto();
    useVoiceCallStore.getState().eventApplied({ assistantSpeaking: true });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('speaking');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('speaking');
    expect(screen.getByTestId('voice-status').textContent).toBe('正在回答');
    expectAtMostTwoActions();
  });

  it('在干活：上行只显示当前任务，下行显示还有 2 件，操作数为 2', () => {
    dialInto();
    const store = useVoiceCallStore.getState();
    store.eventApplied({ workItem: { id: 'w1', title: '正在拉取 Q1-Q3 留存数据', status: 'running' } });
    store.eventApplied({ workItem: { id: 'w2', title: '生成分群结论', status: 'running' } });
    store.eventApplied({ workItem: { id: 'w3', title: '整理汇报', status: 'queued' } });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('working');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('working');
    expect(screen.getByTestId('voice-status').textContent).toBe('正在拉取 Q1-Q3 留存数据');
    expect(screen.getByTestId('voice-meta').textContent).toContain('还有 2 件');
    expect(screen.queryByTestId('voice-work-item-running')).toBeNull();
    expectAtMostTwoActions();
  });

  it('已静音：说清它听不见你，麦克风为琥珀静音态，操作数为 2', () => {
    dialInto();
    useVoiceCallStore.getState().muteChanged(true);
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('muted');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('muted');
    expect(screen.getByTestId('voice-status').textContent).toBe('已静音 · 它听不见你');
    expect(screen.getByTestId('voice-mute').className).toContain('text-amber-300');
    expectAtMostTwoActions();
  });

  it('点按档：只有「点按说话/说完了」与挂断，没有静音键', () => {
    dialInto('manual');
    const { rerender } = render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-status').textContent).toBe('点一下开始说');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('manual-ready');
    expect(screen.getByTestId('voice-manual-commit').textContent).toBe('点按说话');
    expect(screen.queryByTestId('voice-mute')).toBeNull();
    expectAtMostTwoActions();

    fireEvent.click(screen.getByTestId('voice-manual-commit'));
    expect(bridgeMock.manualTap).toHaveBeenCalledTimes(1);
    useVoiceCallStore.getState().pttCaptureChanged(true);
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-status').textContent).toBe('正在听 · 说完再点一下');
    expect(screen.getByTestId('voice-manual-commit').textContent).toBe('说完了');
    expect(screen.queryByTestId('voice-mute')).toBeNull();
    expectAtMostTwoActions();
  });

  it('出错：只保留挂断一个操作', () => {
    dialInto();
    useVoiceCallStore.getState().phaseChanged('error');
    useVoiceCallStore.getState().eventApplied({ error: { code: 'UPSTREAM', message: '连接断了，正在重试…' } });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('error');
    expect(screen.getByTestId('voice-presence').dataset.orbState).toBe('error');
    expect(screen.getByTestId('voice-status').textContent).toBe('连接断了，正在重试…');
    expect(screen.queryByTestId('voice-mute')).toBeNull();
    expect(screen.queryByTestId('voice-manual-commit')).toBeNull();
    expect(chromeButtons()).toEqual([screen.getByTestId('voice-end')]);
  });

  it('麦克风与挂断分别调用 bridge', () => {
    dialInto();
    render(<VoiceChrome sessionId="session-1" />);
    fireEvent.click(screen.getByTestId('voice-mute'));
    fireEvent.click(screen.getByTestId('voice-end'));
    expect(bridgeMock.toggleMute).toHaveBeenCalledTimes(1);
    expect(bridgeMock.hangUp).toHaveBeenCalledTimes(1);
  });
});
