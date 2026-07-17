// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { MCPOAuthConsentRequest } from '../../../src/shared/contract';
import { MCPOAuthConsentModal } from '../../../src/renderer/components/MCPOAuthConsentModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const { invokeMock, invokeDomainMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
  invokeDomainMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
  invokeDomain: invokeDomainMock,
}));

function makeRequest(overrides: Partial<MCPOAuthConsentRequest> = {}): MCPOAuthConsentRequest {
  return {
    requestId: 'consent-123',
    serverName: 'GitHub MCP',
    serverUrl: 'https://mcp.example.com/mcp',
    configSource: 'project',
    scope: 'repo user:email',
    authorizationServer: 'https://github.com',
    redirectHost: '127.0.0.1:49152',
    ...overrides,
  };
}

describe('MCPOAuthConsentModal', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'en' });
    invokeMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the six required consent fields with literal values', () => {
    render(<MCPOAuthConsentModal request={makeRequest()} onClose={vi.fn()} />);

    expect(screen.getByText('Server')).toBeTruthy();
    expect(screen.getByText('Canonical URL')).toBeTruthy();
    expect(screen.getByText('Config source')).toBeTruthy();
    expect(screen.getByText('Scope')).toBeTruthy();
    expect(screen.getByText('Authorization server')).toBeTruthy();
    expect(screen.getByText('Redirect address')).toBeTruthy();
    expect(screen.getByText('GitHub MCP')).toBeTruthy();
    expect(screen.getByText('https://mcp.example.com/mcp')).toBeTruthy();
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getByText('repo user:email')).toBeTruthy();
    expect(screen.getByText('https://github.com')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:49152')).toBeTruthy();
  });

  it('keeps empty configSource and scope rows visible with placeholders', () => {
    render(
      <MCPOAuthConsentModal
        request={makeRequest({ configSource: undefined, scope: '' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Config source')).toBeTruthy();
    expect(screen.getByText('Scope')).toBeTruthy();
    expect(screen.getAllByText('-')).toHaveLength(2);
  });

  it('invokes authorize consent payload and closes', async () => {
    const onClose = vi.fn();
    render(<MCPOAuthConsentModal request={makeRequest()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE,
        { requestId: 'consent-123', action: 'authorize' },
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('invokes decline consent payload and closes', async () => {
    const onClose = vi.fn();
    render(<MCPOAuthConsentModal request={makeRequest()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE,
        { requestId: 'consent-123', action: 'decline' },
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
