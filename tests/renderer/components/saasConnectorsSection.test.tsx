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

interface TestProviderStatus {
  id: string;
  displayName: string;
  clientIdConfigured: boolean;
  requiresClientSecret: boolean;
  clientSecretConfigured: boolean;
  connected: boolean;
  loopbackRedirectUriSupport: string;
  authMode: 'oauth' | 'lark-cli' | 'tmeet-cli';
  step?: 1 | 2;
  blocked?: boolean;
  userName?: string;
  tenantName?: string;
}

const baseStatus: TestProviderStatus = {
  id: 'feishu',
  displayName: '飞书',
  clientIdConfigured: true,
  requiresClientSecret: true,
  clientSecretConfigured: false,
  connected: false,
  loopbackRedirectUriSupport: 'confirmed',
  authMode: 'oauth',
};

const larkCliStatus: TestProviderStatus = {
  ...baseStatus,
  requiresClientSecret: false,
  authMode: 'lark-cli',
};

const tmeetCliStatus: TestProviderStatus = {
  ...baseStatus,
  id: 'tmeet',
  displayName: '腾讯会议',
  requiresClientSecret: false,
  authMode: 'tmeet-cli',
};

function renderStatus(overrides: Partial<TestProviderStatus> = {}) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'oauthStatus') return Promise.resolve([{ ...baseStatus, ...overrides }]);
    return Promise.resolve([]);
  });
  return render(<SaaSConnectorsSection />);
}

function renderLarkCliStatus(overrides: Partial<TestProviderStatus> = {}) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'oauthStatus') return Promise.resolve([{ ...larkCliStatus, ...overrides }]);
    return Promise.resolve([]);
  });
  return render(<SaaSConnectorsSection />);
}

function renderTmeetCliStatus(overrides: Partial<TestProviderStatus> = {}) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'oauthStatus') return Promise.resolve([{ ...tmeetCliStatus, ...overrides }]);
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

describe('SaaSConnectorsSection Feishu lark-cli six states', () => {
  it('state 1: offers Connect Feishu, browser explanation, and the in-card custom-app escape hatch', async () => {
    renderLarkCliStatus();

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.notConnected);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.larkCliReady);
    const connectButton = within(card).getByTestId('saas-connect-feishu');
    expect(connectButton.textContent).toContain(zh.settings.saasConnectors.actions.connectFeishu);
    expect(within(card).getByTestId('saas-custom-app-toggle-feishu').textContent)
      .toContain(zh.settings.saasConnectors.customApp.title);
    fireEvent.click(connectButton);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthConnect',
      { providerId: 'feishu', action: 'message.send-as-user', authMode: 'lark-cli' },
    ));
  });

  it('state 2: renders step 1 of 2 with app-creation guidance and cancel', async () => {
    renderLarkCliStatus({ step: 1 });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.connectingStep1);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.creatingApp);
    fireEvent.click(within(card).getByTestId('saas-cancel-feishu'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthCancelConnect',
      { providerId: 'feishu' },
    ));
  });

  it('state 3: renders step 2 of 2 with authorization guidance and cancel', async () => {
    renderLarkCliStatus({ step: 2 });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.connectingStep2);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.authorizing);
    expect(within(card).getByTestId('saas-cancel-feishu')).toBeTruthy();
  });

  it('state 4: shows connected user@tenant when both real status fields are present', async () => {
    renderLarkCliStatus({ connected: true, userName: 'Neo User', tenantName: 'Neo Corp' });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain('已连接 · Neo User@Neo Corp');
    fireEvent.click(within(card).getByTestId('saas-disconnect-feishu'));
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.larkCliConfirmMessage)).toBeTruthy();
  });

  it('connected identity falls back to the connected badge when tenant data is absent', async () => {
    renderLarkCliStatus({ connected: true, userName: 'Neo User' });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.connected);
    expect(card.textContent).not.toContain('Neo User@');
  });

  it('state 5: maps the enterprise-policy block to the fixed admin copy and retry', async () => {
    renderLarkCliStatus({ blocked: true });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.adminRequired);
    expect(card.textContent).toContain('需联系企业应用管理员安装');
    expect(within(card).getByTestId('saas-retry-feishu')).toBeTruthy();
  });

  it('state 6: expands the existing password flow inside the card for a custom Feishu app', async () => {
    renderLarkCliStatus();

    const card = await screen.findByTestId('saas-connector-feishu');
    fireEvent.click(within(card).getByTestId('saas-custom-app-toggle-feishu'));
    const secretInput = within(card).getByTestId('saas-custom-secret-input-feishu');
    expect(secretInput.getAttribute('type')).toBe('password');
    expect(card.textContent).toContain(zh.settings.saasConnectors.secret.customAppHint);
    fireEvent.change(secretInput, { target: { value: 'fake-custom-secret' } });
    fireEvent.click(within(card).getByTestId('saas-custom-save-connect-feishu'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthSetSecret',
      { providerId: 'feishu', clientSecret: 'fake-custom-secret', authMode: 'oauth' },
    ));
  });
});

describe('SaaSConnectorsSection Tencent Meeting CLI card', () => {
  it('offers the tmeet action with one browser-authorization step', async () => {
    renderTmeetCliStatus();

    const card = await screen.findByTestId('saas-connector-tmeet');
    expect(card.textContent).toContain(zh.settings.saasConnectors.providers.tmeet);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.tmeetCliReady);
    fireEvent.click(within(card).getByTestId('saas-connect-tmeet'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthConnect',
      { providerId: 'tmeet', action: 'meeting.create', authMode: 'tmeet-cli' },
    ));
  });

  it('keeps step fixed at 1 and tells the user to finish in the browser', async () => {
    renderTmeetCliStatus({ step: 1 });

    const card = await screen.findByTestId('saas-connector-tmeet');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.connectingSingle);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.tmeetAuthorizing);
    expect(within(card).getByTestId('saas-cancel-tmeet')).toBeTruthy();
  });

  it('uses Tencent Meeting disconnect copy for a connected account', async () => {
    renderTmeetCliStatus({ connected: true });

    const card = await screen.findByTestId('saas-connector-tmeet');
    fireEvent.click(card);
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.tmeetCliNotice)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('saas-detail-tmeet')).getByTestId('saas-disconnect-tmeet'));
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.tmeetCliConfirmMessage)).toBeTruthy();
  });
});

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
    const detail = openFeishuDetail();
    expect(within(detail).getByText(zh.settings.saasConnectors.details.missingClientId)).toBeTruthy();
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
        { providerId: 'feishu', clientSecret: '  app-secret-value  ', authMode: 'oauth' },
      );
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.CONNECTOR,
        'oauthConnect',
        { providerId: 'feishu', action: 'message.send-as-user', authMode: 'oauth' },
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
