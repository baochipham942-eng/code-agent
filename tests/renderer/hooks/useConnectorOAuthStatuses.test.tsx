// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: invokeDomainMock },
}));

import { useConnectorOAuthStatuses } from '../../../src/renderer/hooks/useConnectorOAuthStatuses';

function Probe(props: { refreshKey: string; enabled?: boolean }) {
  const statuses = useConnectorOAuthStatuses(props.refreshKey, props.enabled);
  return <span data-testid="statuses">{statuses.map((status) => `${status.id}:${status.connected}`).join(',')}</span>;
}

afterEach(() => {
  cleanup();
  invokeDomainMock.mockReset();
});

describe('useConnectorOAuthStatuses', () => {
  it('enabled 时拉取并解析；失败保留旧值不清空', async () => {
    invokeDomainMock.mockResolvedValue([{ id: 'tmeet', connected: true }]);
    const { rerender, getByTestId } = render(<Probe refreshKey="a" enabled />);
    await waitFor(() => expect(getByTestId('statuses').textContent).toBe('tmeet:true'));

    // 下一次拉取失败：保留旧值，不翻成「未连接」
    invokeDomainMock.mockRejectedValue(new Error('ipc down'));
    rerender(<Probe refreshKey="b" enabled />);
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledTimes(2));
    expect(getByTestId('statuses').textContent).toBe('tmeet:true');
  });

  // oauthStatus 冷缓存会对 feishu/tmeet 起 CLI 子进程做 status()——
  // 没有 CLI 连接器在场时（enabled=false）不许发那次 IPC
  it('enabled=false 时不发 IPC', () => {
    render(<Probe refreshKey="a" enabled={false} />);
    expect(invokeDomainMock).not.toHaveBeenCalled();
  });
});
