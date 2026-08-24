// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { SaaSConnectorsSection } from '../../../src/renderer/components/features/settings/sections/SaaSConnectorsSection';

const baseStatus = {
  id: 'feishu',
  displayName: '飞书',
  clientIdConfigured: true,
  requiresClientSecret: true,
  clientSecretConfigured: false,
  connected: false,
  loopbackRedirectUriSupport: 'confirmed',
};

function renderStatus(overrides: Partial<typeof baseStatus> = {}) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'oauthStatus') return Promise.resolve([{ ...baseStatus, ...overrides }]);
    return Promise.resolve([]);
  });
  return render(<SaaSConnectorsSection />);
}

beforeEach(() => {
  invokeDomain.mockReset();
});

afterEach(cleanup);

describe('SaaSConnectorsSection provider states', () => {
  it('A: missing secret expands the password field and only offers save-and-connect', async () => {
    renderStatus();

    expect(await screen.findByText(zh.settings.saasConnectors.badges.needsSetup)).toBeTruthy();
    expect(screen.getByTestId('saas-secret-input-feishu').getAttribute('type')).toBe('password');
    expect(screen.getByTestId('saas-save-connect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('B: saved secret shows connect without rendering the secret field or disconnect', async () => {
    renderStatus({ clientSecretConfigured: true });

    expect(await screen.findByText(zh.settings.saasConnectors.badges.notConnected)).toBeTruthy();
    expect(screen.getByTestId('saas-connector-feishu').textContent)
      .toContain(zh.settings.saasConnectors.clientSecretSaved);
    expect(screen.getByTestId('saas-connect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('C: connected shows the permanent secret-removal notice and only offers disconnect', async () => {
    renderStatus({ clientSecretConfigured: true, connected: true });

    expect(await screen.findByText(zh.settings.saasConnectors.badges.connected)).toBeTruthy();
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.noticeWithSecret)).toBeTruthy();
    expect(screen.getByTestId('saas-disconnect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
  });

  it('D: a provider that does not require a secret connects directly without a secret field', async () => {
    renderStatus({ requiresClientSecret: false });

    expect(await screen.findByText(zh.settings.saasConnectors.details.noSecretRequired)).toBeTruthy();
    expect(screen.getByTestId('saas-connect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-save-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('missing client_id explains the packaging gap and renders no action button', async () => {
    renderStatus({ clientIdConfigured: false });

    expect(await screen.findByText(zh.settings.saasConnectors.details.missingClientId)).toBeTruthy();
    expect(screen.getByTestId('saas-connector-feishu').textContent)
      .toContain(`${zh.settings.saasConnectors.availableActionsPrefix}${zh.settings.saasConnectors.actions.none}`);
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-save-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('fails closed when any status field is missing', async () => {
    const { connected: _connected, ...incompleteStatus } = baseStatus;
    invokeDomain.mockResolvedValue([incompleteStatus]);
    render(<SaaSConnectorsSection />);

    expect(await screen.findByText(zh.settings.saasConnectors.errors.statusUnavailable)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('SaaSConnectorsSection actions', () => {
  it('saves the untrimmed secret, refreshes status, then starts the mapped OAuth action', async () => {
    let statusCall = 0;
    invokeDomain.mockImplementation((_domain: string, action: string, payload?: unknown) => {
      if (action === 'oauthStatus') {
        statusCall += 1;
        return Promise.resolve([{ ...baseStatus, clientSecretConfigured: statusCall > 1 }]);
      }
      if (action === 'oauthSetSecret') return Promise.resolve([]);
      if (action === 'oauthConnect') {
        return Promise.resolve([{ ...baseStatus, clientSecretConfigured: true, connected: true }]);
      }
      throw new Error(`Unexpected action ${action}: ${String(payload)}`);
    });
    render(<SaaSConnectorsSection />);

    const input = await screen.findByTestId('saas-secret-input-feishu');
    fireEvent.change(input, { target: { value: '  app-secret-value  ' } });
    fireEvent.click(screen.getByTestId('saas-save-connect-feishu'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.CONNECTOR,
        'oauthSetSecret',
        { providerId: 'feishu', clientSecret: '  app-secret-value  ' },
      );
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.CONNECTOR,
        'oauthConnect',
        { providerId: 'feishu', action: 'message.send-as-user' },
      );
    });

    const actions = invokeDomain.mock.calls.map(([, action]) => action);
    expect(actions.slice(0, 4)).toEqual([
      'oauthStatus',
      'oauthSetSecret',
      'oauthStatus',
      'oauthConnect',
    ]);
  });

  it('disconnects only after one confirmation and refreshes from oauthStatus', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') {
        return Promise.resolve([{ ...baseStatus, clientSecretConfigured: true, connected: true }]);
      }
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    fireEvent.click(await screen.findByTestId('saas-disconnect-feishu'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(invokeDomain.mock.calls.map(([, action]) => action)).not.toContain('oauthDisconnect');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {
      name: zh.settings.saasConnectors.actions.disconnect,
    }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.CONNECTOR,
        'oauthDisconnect',
        { providerId: 'feishu' },
      );
    });
    expect(invokeDomain.mock.calls.map(([, action]) => action).at(-1)).toBe('oauthStatus');
  });
});
