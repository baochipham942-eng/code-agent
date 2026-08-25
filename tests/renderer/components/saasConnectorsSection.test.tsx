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

function openFeishuDetail() {
  fireEvent.click(screen.getByTestId('saas-connector-feishu'));
  return screen.getByTestId('saas-detail-feishu');
}

beforeEach(() => {
  invokeDomain.mockReset();
});

afterEach(cleanup);

describe('SaaSConnectorsSection five card states', () => {
  it('needs_secret: card opens a password field and only offers save-and-connect', async () => {
    renderStatus();

    expect((await screen.findByTestId('saas-connector-feishu')).textContent)
      .toContain(zh.settings.saasConnectors.badges.needsSetup);
    openFeishuDetail();
    expect(screen.getByTestId('saas-secret-input-feishu').getAttribute('type')).toBe('password');
    expect(screen.getByTestId('saas-save-connect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('ready: saved secret shows a connection entry without rendering secret or disconnect', async () => {
    renderStatus({ clientSecretConfigured: true });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.notConnected);
    expect(card.textContent).toContain(zh.settings.saasConnectors.clientSecretSaved);
    openFeishuDetail();
    expect(screen.getByTestId('saas-connect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('connecting: oauthConnect in flight overrides the card with orange local progress and toast', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') {
        return Promise.resolve([{ ...baseStatus, clientSecretConfigured: true }]);
      }
      if (action === 'oauthConnect') {
        return new Promise<void>(() => undefined);
      }
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    await screen.findByTestId('saas-connector-feishu');
    openFeishuDetail();
    fireEvent.click(screen.getByTestId('saas-connect-feishu'));

    await waitFor(() => {
      expect(screen.getByTestId('saas-connector-feishu').textContent)
        .toContain(zh.settings.saasConnectors.badges.connecting);
      expect(screen.getByTestId('saas-status-dot-feishu').className).toContain('bg-amber-400');
      expect(screen.getByTestId('saas-connector-toast').textContent)
        .toContain(zh.settings.saasConnectors.toast.authorizationOpened);
    });
  });

  it('connected: green card opens permanent secret-removal notice and disconnect action', async () => {
    renderStatus({ clientSecretConfigured: true, connected: true });

    expect((await screen.findByTestId('saas-status-dot-feishu')).className).toContain('bg-mark-success');
    openFeishuDetail();
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.noticeWithSecret)).toBeTruthy();
    expect(screen.getByTestId('saas-disconnect-feishu')).toBeTruthy();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
  });

  it('unavailable: missing client_id remains explainable but has no clickable action control', async () => {
    renderStatus({ clientIdConfigured: false });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.unavailable);
    expect(screen.queryByTestId('saas-card-action-feishu')).toBeNull();
    openFeishuDetail();
    expect(screen.getByText(zh.settings.saasConnectors.details.missingClientId)).toBeTruthy();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-save-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
  });

  it('fails closed when any oauthStatus field is missing', async () => {
    const { connected: _connected, ...incompleteStatus } = baseStatus;
    invokeDomain.mockResolvedValue([incompleteStatus]);
    render(<SaaSConnectorsSection />);

    expect(await screen.findByText(zh.settings.saasConnectors.errors.statusUnavailable)).toBeTruthy();
    expect(document.querySelector('button')).toBeNull();
  });
});

describe('SaaSConnectorsSection actions and receipts', () => {
  it('saves the untrimmed secret, refreshes, connects, and acknowledges success', async () => {
    let statusCall = 0;
    invokeDomain.mockImplementation((_domain: string, action: string, payload?: unknown) => {
      if (action === 'oauthStatus') {
        statusCall += 1;
        return Promise.resolve([{
          ...baseStatus,
          clientSecretConfigured: statusCall > 1,
          connected: statusCall > 2,
        }]);
      }
      if (action === 'oauthSetSecret' || action === 'oauthConnect') return Promise.resolve([]);
      throw new Error(`Unexpected action ${action}: ${String(payload)}`);
    });
    render(<SaaSConnectorsSection />);

    await screen.findByTestId('saas-connector-feishu');
    openFeishuDetail();
    fireEvent.change(screen.getByTestId('saas-secret-input-feishu'), {
      target: { value: '  app-secret-value  ' },
    });
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
      expect(screen.getByTestId('saas-connector-toast').textContent)
        .toContain(zh.settings.saasConnectors.toast.connected);
    });

    expect(invokeDomain.mock.calls.map(([, action]) => action).slice(0, 5)).toEqual([
      'oauthStatus',
      'oauthSetSecret',
      'oauthStatus',
      'oauthConnect',
      'oauthStatus',
    ]);
  });

  it('disconnects only after confirmation, refreshes, and acknowledges the result', async () => {
    let disconnected = false;
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') {
        return Promise.resolve([{
          ...baseStatus,
          clientSecretConfigured: !disconnected,
          connected: !disconnected,
        }]);
      }
      if (action === 'oauthDisconnect') {
        disconnected = true;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    await screen.findByTestId('saas-connector-feishu');
    openFeishuDetail();
    fireEvent.click(screen.getByTestId('saas-disconnect-feishu'));
    expect(invokeDomain.mock.calls.map(([, action]) => action)).not.toContain('oauthDisconnect');

    fireEvent.click(within(screen.getByRole('dialog', {
      name: zh.settings.saasConnectors.disconnect.confirmTitle,
    })).getByRole('button', {
      name: zh.settings.saasConnectors.actions.disconnect,
    }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.CONNECTOR,
        'oauthDisconnect',
        { providerId: 'feishu' },
      );
      expect(screen.getByTestId('saas-connector-toast').textContent)
        .toContain(zh.settings.saasConnectors.toast.disconnected);
    });
  });

  it('acknowledges cancellation returned by the OAuth flow', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') {
        return Promise.resolve([{ ...baseStatus, clientSecretConfigured: true }]);
      }
      if (action === 'oauthConnect') return Promise.reject({ code: 'CANCELLED' });
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    await screen.findByTestId('saas-connector-feishu');
    openFeishuDetail();
    fireEvent.click(screen.getByTestId('saas-connect-feishu'));

    await waitFor(() => {
      expect(screen.getByTestId('saas-connector-toast').textContent)
        .toContain(zh.settings.saasConnectors.toast.authorizationCancelled);
    });
  });

  it('keeps the read-only Feishu MCP route inside the advanced detail area', async () => {
    const configureReadonly = vi.fn();
    renderStatus({ clientSecretConfigured: true });
    cleanup();
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') return Promise.resolve([{ ...baseStatus, clientSecretConfigured: true }]);
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection onConfigureReadonlyMcp={configureReadonly} />);

    await screen.findByTestId('saas-connector-feishu');
    openFeishuDetail();
    fireEvent.click(screen.getByText(zh.settings.saasConnectors.advanced.title));
    fireEvent.click(screen.getByText(zh.settings.saasConnectors.advanced.configure));
    expect(configureReadonly).toHaveBeenCalledTimes(1);
  });
});
