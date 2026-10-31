// @vitest-environment jsdom
// N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE：insufficient_scope 连接卡（重新授权按钮 / 可选链接 / 不被 watcher 自动消掉）
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_REQUIRED_POLL } from '../../../src/shared/constants';

const ipcMock = vi.hoisted(() => ({
  reauthorize: vi.fn(),
  invokeDomain: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: ipcMock.invokeDomain, on: ipcMock.on },
}));

import { ConnectorRequiredCards } from '../../../src/renderer/components/features/chat/connectorRequiredCard';
import { parseConnectorRequiredPayload, useConnectorRequiredStore } from '../../../src/renderer/stores/connectorRequiredStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { startConnectorRequiredWatcher } from '../../../src/renderer/utils/connectorRequiredWatcher';

const sendPrompt = vi.fn(async () => undefined);
const scopeItem = { id: 'notion', source: 'selected' as const, reason: 'insufficient_scope', requiredScope: 'write' };

describe('insufficient_scope connector card', () => {
  beforeEach(() => {
    ipcMock.reauthorize.mockReset();
    ipcMock.invokeDomain.mockReset();
    ipcMock.invokeDomain.mockImplementation(async (domain: string, method: string, payload: unknown) => {
      if (method === 'reauthorizeServer') return ipcMock.reauthorize(domain, payload);
      return method === 'oauthStatus' ? [{ id: 'notion', connected: true }] : [];
    });
    sendPrompt.mockClear();
    useConnectorRequiredStore.setState({ entries: {} });
    useAppStore.setState({ language: 'zh' } as never);
    useMessageActionStore.setState({ _send: vi.fn(), sendPrompt } as never);
    useSessionStore.setState({ currentSessionId: 's1', runningSessionIds: new Set() });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('shows 重新授权 and no permission link when helpUrl is absent', () => {
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('当前的授权缺少这次操作需要的权限');
    expect(screen.getByTestId('connector-required-reauthorize').textContent).toBe('重新授权');
    expect(screen.queryByTestId('connector-required-help-link')).toBeNull();
  });

  it('shows the permission link only when helpUrl is present, alongside 重新授权', () => {
    useConnectorRequiredStore.getState().report('s1', [{ ...scopeItem, helpUrl: 'https://example.test/permissions' }]);
    render(<ConnectorRequiredCards />);
    expect(screen.getByTestId('connector-required-help-link')).toBeTruthy();
    expect(screen.getByTestId('connector-required-reauthorize')).toBeTruthy();
  });

  it('click 重新授权 → host action with the missing scope → success state asks to resend', async () => {
    ipcMock.reauthorize.mockResolvedValue({ success: true });
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(ipcMock.reauthorize).toHaveBeenCalledWith('domain:mcp', { serverName: 'notion', requiredScope: 'write' });
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('已重新授权，请重新发送刚才的请求');
    expect(screen.queryByTestId('connector-required-reauthorize')).toBeNull();
  });

  it('denied / failed authorization keeps the card with the failure and lets the user retry', async () => {
    ipcMock.reauthorize.mockResolvedValueOnce({ success: false, error: 'declined' }).mockResolvedValueOnce({ success: true });
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(screen.getByTestId('connector-required-reauth-error').textContent).toContain('declined');
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('已重新授权');
  });

  it('is NOT auto-resolved by the watcher while the connector reports connected', async () => {
    vi.useFakeTimers();
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    const stop = startConnectorRequiredWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * 3); });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useConnectorRequiredStore.getState().entries['s1::notion']?.status).toBe('pending');
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('缺少这次操作需要的权限');
    stop();
  });

  it('parseConnectorRequiredPayload keeps requiredScope/helpUrl and drops empties', () => {
    expect(parseConnectorRequiredPayload({ connectors: [{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write', helpUrl: '' }] }))
      .toEqual([{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write' }]);
  });
});
