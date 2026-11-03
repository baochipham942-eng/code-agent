// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_REQUIRED_POLL } from '../../../src/shared/constants';

const ipcMock = vi.hoisted(() => ({
  oauth: [] as Array<{ id: string; connected: boolean }>,
  invokeDomain: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: ipcMock.invokeDomain, on: ipcMock.on },
}));

import { ConnectorRequiredCards } from '../../../src/renderer/components/features/chat/connectorRequiredCard';
import { useConnectorRequiredStore } from '../../../src/renderer/stores/connectorRequiredStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { resumeConnectorTask, startConnectorRequiredWatcher } from '../../../src/renderer/utils/connectorRequiredWatcher';

const sendPrompt = vi.fn(async () => undefined);
const openCapabilitySettingsTarget = vi.fn();
const feishu = { id: 'feishu', source: 'selected' as const, reason: 'not_connected' };

function setSession(sessionId: string, running = false): void {
  useSessionStore.setState({ currentSessionId: sessionId, runningSessionIds: new Set(running ? [sessionId] : []) });
}

describe('ConnectorRequiredCards + watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipcMock.oauth = [{ id: 'feishu', connected: false }];
    ipcMock.invokeDomain.mockReset();
    ipcMock.invokeDomain.mockImplementation(async (_domain: string, method: string) =>
      method === 'oauthStatus' ? ipcMock.oauth : []);
    sendPrompt.mockClear();
    openCapabilitySettingsTarget.mockClear();
    useConnectorRequiredStore.setState({ entries: {} });
    useAppStore.setState({ language: 'zh', openCapabilitySettingsTarget } as never);
    useMessageActionStore.setState({ _send: vi.fn(), sendPrompt } as never);
    setSession('s1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the connector name with both buttons; 去连接 opens the connector settings target', () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    render(<ConnectorRequiredCards />);
    const card = screen.getByTestId('connector-required-card-feishu');
    expect(card.textContent).toContain('飞书 还没连接');
    expect(screen.getByTestId('connector-required-connect').textContent).toBe('去连接');
    expect(screen.getByTestId('connector-required-later').textContent).toBe('稍后');
    fireEvent.click(screen.getByTestId('connector-required-connect'));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'connector', id: 'feishu' });
  });

  it('does not render cards that belong to another session', () => {
    useConnectorRequiredStore.getState().report('other', [feishu]);
    const { container } = render(<ConnectorRequiredCards />);
    expect(container.innerHTML).toBe('');
  });

  it('status flip → sendPrompt exactly once, card turns into the continuing line', async () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    render(<ConnectorRequiredCards />);
    const stop = startConnectorRequiredWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS); });
    expect(sendPrompt).not.toHaveBeenCalled();

    ipcMock.oauth = [{ id: 'feishu', connected: true }];
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * 3); });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('飞书 已连接，请继续刚才的任务');
    expect(screen.getByTestId('connector-required-card-feishu').textContent).toContain('飞书 已连接，正在继续');
    stop();
  });

  it('double trigger sends the continuation only once (send-once guard)', () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    const entry = useConnectorRequiredStore.getState().entries['s1::feishu'];
    expect(resumeConnectorTask(entry)).toBe(true);
    expect(resumeConnectorTask(entry)).toBe(false);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('waits while a run is active or the user is on another session, then continues once', async () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    ipcMock.oauth = [{ id: 'feishu', connected: true }];
    setSession('s1', true);
    const stop = startConnectorRequiredWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS); });
    expect(sendPrompt).not.toHaveBeenCalled();

    act(() => { setSession('s2'); });
    expect(sendPrompt).not.toHaveBeenCalled();

    act(() => { setSession('s1'); });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * 3); });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    stop();
  });

  it('稍后 hides the card and suppresses a second card for the same session+connector', () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    const { container } = render(<ConnectorRequiredCards />);
    fireEvent.click(screen.getByTestId('connector-required-later'));
    expect(container.innerHTML).toBe('');
    act(() => { useConnectorRequiredStore.getState().report('s1', [feishu]); });
    expect(container.innerHTML).toBe('');
    // 另一个会话不受影响
    act(() => { useConnectorRequiredStore.getState().report('s2', [feishu]); });
    act(() => { setSession('s2'); });
    expect(screen.getByTestId('connector-required-card-feishu')).toBeTruthy();
  });

  it('polling stops at the cap and the manual button sends the continuation once', async () => {
    useConnectorRequiredStore.getState().report('s1', [feishu]);
    render(<ConnectorRequiredCards />);
    const stop = startConnectorRequiredWatcher();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * (CONNECTOR_REQUIRED_POLL.MAX_POLLS + 2));
    });
    const callsAtCap = ipcMock.invokeDomain.mock.calls.length;
    expect(useConnectorRequiredStore.getState().entries['s1::feishu'].gaveUp).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * 10); });
    expect(ipcMock.invokeDomain.mock.calls.length).toBe(callsAtCap);

    const manual = screen.getByTestId('connector-required-manual');
    expect(manual.textContent).toBe('我已连好，继续');
    fireEvent.click(manual);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('connector-required-manual')).toBeNull();
    stop();
  });
});
