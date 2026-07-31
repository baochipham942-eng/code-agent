// @vitest-environment jsdom
// VoiceChrome 固定槽位行为门：正常已建连状态统一“通话中 mm:ss”，
// 不展示助手名、模型名、work item 标题与剩余工作数。
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

const ON_CALL_REGEX = /^通话中 \d{2}:\d{2}$/;

describe('VoiceChrome 固定槽位', () => {
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

  it('连接中：显示本地化状态，麦克风 disabled，不展示助手/时长元信息，操作数为 2', () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'lanxi', 'server_vad');
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('connecting');
    expect(screen.getByTestId('voice-status').textContent).toBe('正在接通…');
    expect(screen.queryByTestId('voice-meta')).toBeNull();
    expect(screen.getByTestId('voice-mute').hasAttribute('disabled')).toBe(true);
    expectAtMostTwoActions();
  });

  it('正在听：统一显示“通话中 mm:ss”，麦克风可用，时长按秒更新，操作数为 2', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00+08:00'));
    dialInto();
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-status').textContent).toMatch(/^通话中 00:00$/);
    expect(screen.queryByTestId('voice-meta')).toBeNull();
    expect(screen.getByTestId('voice-mute').hasAttribute('disabled')).toBe(false);
    expectAtMostTwoActions();

    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByTestId('voice-status').textContent).toMatch(/^通话中 01:01$/);
  });

  it('正在回答：统一显示“通话中 mm:ss”，操作数为 2', () => {
    dialInto();
    useVoiceCallStore.getState().eventApplied({ assistantSpeaking: true });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('speaking');
    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expectAtMostTwoActions();
  });

  it('在干活：统一显示“通话中 mm:ss”，不显示当前任务与剩余工作数，操作数为 2', () => {
    dialInto();
    const store = useVoiceCallStore.getState();
    store.eventApplied({ workItem: { id: 'w1', title: '正在拉取 Q1-Q3 留存数据', status: 'running' } });
    store.eventApplied({ workItem: { id: 'w2', title: '生成分群结论', status: 'running' } });
    store.eventApplied({ workItem: { id: 'w3', title: '整理汇报', status: 'queued' } });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('working');
    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expect(screen.queryByTestId('voice-meta')).toBeNull();
    expect(screen.queryByTestId('voice-work-item-running')).toBeNull();
    expectAtMostTwoActions();
  });

  it('已静音：统一显示“通话中 mm:ss”，麦克风为琥珀静音态，操作数为 2', () => {
    dialInto();
    useVoiceCallStore.getState().muteChanged(true);
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('muted');
    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expect(screen.getByTestId('voice-mute').className).toContain('text-amber-300');
    expectAtMostTwoActions();
  });

  it('点按档：状态仍显示“通话中 mm:ss”，保留「点按说话/说完了」与挂断，没有静音键', () => {
    dialInto('manual');
    const { rerender } = render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expect(screen.getByTestId('voice-manual-commit').textContent).toBe('点按说话');
    expect(screen.queryByTestId('voice-mute')).toBeNull();
    expectAtMostTwoActions();

    fireEvent.click(screen.getByTestId('voice-manual-commit'));
    expect(bridgeMock.manualTap).toHaveBeenCalledTimes(1);
    useVoiceCallStore.getState().pttCaptureChanged(true);
    rerender(<VoiceChrome sessionId="session-1" />);
    expect(screen.getByTestId('voice-status').textContent).toMatch(ON_CALL_REGEX);
    expect(screen.getByTestId('voice-manual-commit').textContent).toBe('说完了');
    expect(screen.queryByTestId('voice-mute')).toBeNull();
    expectAtMostTwoActions();
  });

  it('出错：只保留挂断一个操作', () => {
    dialInto();
    useVoiceCallStore.getState().phaseChanged('error');
    useVoiceCallStore.getState().eventApplied({ error: { code: 'UPSTREAM_ERROR', message: 'upstream blew up' } });
    render(<VoiceChrome sessionId="session-1" />);

    expect(screen.getByTestId('voice-chrome').dataset.state).toBe('error');
    // 文案按 code 查 i18n，不是显示 host 原文（host 那句是硬编码中文，英文用户会原样看到）。
    // 断言取 i18n 的值而不是写死字符串——写死就变成「改文案必改测试」的假门。
    expect(screen.getByTestId('voice-status').textContent).toBe(zh.voice.messageByCode.UPSTREAM_ERROR);
    expect(screen.getByTestId('voice-status').textContent).not.toBe('upstream blew up');
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
