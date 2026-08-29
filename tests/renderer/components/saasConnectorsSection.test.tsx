// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());
const useInChat = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/hooks/useConnectorInChat', () => ({
  useConnectorInChat: () => useInChat,
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
  authorizationOpened?: boolean;
  blocked?: boolean;
  stale?: boolean;
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
  useInChat.mockReset();
  window.localStorage.clear();
});

afterEach(cleanup);

describe('SaaSConnectorsSection custom OAuth entry', () => {
  it('creates a runtime connector from the five required descriptor fields', async () => {
    let saved = false;
    const customStatus: TestProviderStatus = {
      id: 'custom-oauth',
      displayName: 'accounts.example.com',
      clientIdConfigured: true,
      requiresClientSecret: true,
      clientSecretConfigured: false,
      connected: false,
      loopbackRedirectUriSupport: 'confirmed',
      authMode: 'oauth',
    };
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') return Promise.resolve(saved ? [baseStatus, customStatus] : [baseStatus]);
      if (action === 'oauthSaveDescriptor') {
        saved = true;
        return Promise.resolve([baseStatus, customStatus]);
      }
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    fireEvent.click(screen.getByTestId('saas-custom-oauth-toggle'));
    fireEvent.change(screen.getByTestId('saas-custom-authorize-url'), {
      target: { value: 'https://accounts.example.com/oauth/authorize' },
    });
    fireEvent.change(screen.getByTestId('saas-custom-token-url'), {
      target: { value: 'https://api.example.com/oauth/token' },
    });
    fireEvent.change(screen.getByTestId('saas-custom-client-id'), {
      target: { value: 'client-123' },
    });
    fireEvent.click(screen.getByTestId('saas-custom-requires-secret'));
    fireEvent.change(screen.getByTestId('saas-custom-loopback-support'), {
      target: { value: 'confirmed' },
    });
    fireEvent.click(screen.getByTestId('saas-custom-save'));

    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthSaveDescriptor',
      {
        authorizeUrl: 'https://accounts.example.com/oauth/authorize',
        tokenUrl: 'https://api.example.com/oauth/token',
        clientId: 'client-123',
        requiresClientSecret: true,
        loopbackRedirectUriSupport: 'confirmed',
      },
    ));
    expect(await screen.findByTestId('saas-connector-custom-oauth')).toBeTruthy();
    expect(screen.getByTestId('saas-detail-custom-oauth').textContent)
      .toContain(zh.settings.saasConnectors.secret.label);
  });

  it('does not expose a generic OAuth connection as a chat connector tool', async () => {
    renderStatus({
      id: 'custom-oauth',
      displayName: 'api.example.com',
      requiresClientSecret: false,
      clientSecretConfigured: false,
      connected: true,
    });

    await screen.findByTestId('saas-connector-custom-oauth');
    expect(screen.queryByTestId('saas-use-in-chat-custom-oauth')).toBeNull();
  });
});

describe('SaaSConnectorsSection Feishu lark-cli six states', () => {
  it('renders persisted cards on the first frame while the background refresh is pending', () => {
    window.localStorage.setItem('code-agent:connector-oauth-statuses', JSON.stringify([
      { ...larkCliStatus, connected: true, userName: 'Cached User', tenantName: 'Cached Corp' },
      tmeetCliStatus,
    ]));
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') return new Promise(() => undefined);
      return Promise.resolve([]);
    });

    render(<SaaSConnectorsSection />);

    expect(screen.getByTestId('saas-connector-feishu').textContent)
      .toContain(zh.settings.saasConnectors.badges.connected);
    expect(screen.getByTestId('saas-connector-tmeet')).toBeTruthy();
    expect(screen.queryByTestId('saas-connector-skeleton-feishu')).toBeNull();
  });

  it('shows card-shaped skeletons when no persisted status exists', () => {
    invokeDomain.mockImplementation(() => new Promise(() => undefined));

    render(<SaaSConnectorsSection />);

    expect(screen.getByTestId('saas-connector-skeleton-feishu')).toBeTruthy();
    expect(screen.getByTestId('saas-connector-skeleton-google-calendar')).toBeTruthy();
    expect(screen.getByTestId('saas-connector-skeleton-tmeet')).toBeTruthy();
  });

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
    fireEvent.click(within(card).getByTestId('saas-card-action-feishu'));
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
    const logo = within(card).getByRole('img', { name: '腾讯会议' });
    expect(logo.getAttribute('src')).toMatch(/tmeet\.png$/u);
    expect(logo.parentElement?.className).toContain('h-7');
    expect(logo.parentElement?.className).toContain('w-7');
    expect(card.textContent).toContain(zh.settings.saasConnectors.providers.tmeet);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.tmeetCliReady);
    fireEvent.click(within(card).getByTestId('saas-connect-tmeet'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'oauthConnect',
      { providerId: 'tmeet', action: 'meeting.create', authMode: 'tmeet-cli' },
    ));
  });

  it('uses the official PNG when the descriptor declares one', async () => {
    renderLarkCliStatus();

    const card = await screen.findByTestId('saas-connector-feishu');
    const cardLogo = within(card).getByRole('img', { name: '飞书' });
    expect(cardLogo.parentElement?.className).toContain('h-7');
    expect(cardLogo.parentElement?.className).toContain('w-7');
    expect(within(card).getByTestId('connector-logo-feishu')).toBeTruthy();

    const detail = openFeishuDetail();
    const detailLogo = within(detail).getByRole('img', { name: '飞书' });
    expect(detailLogo.parentElement?.className).toContain('h-8');
    expect(detailLogo.parentElement?.className).toContain('w-8');
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
    expect(within(card).getByTestId('saas-use-in-chat-tmeet').textContent)
      .toBe(zh.settings.saasConnectors.actions.startUsing);
    expect(within(card).queryByTestId('saas-disconnect-tmeet')).toBeNull();
    fireEvent.click(card);
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.tmeetCliNotice)).toBeTruthy();
    fireEvent.click(within(card).getByTestId('saas-card-action-tmeet'));
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.tmeetCliConfirmMessage)).toBeTruthy();
  });

  it('shows an unknown stale probe without offering a false reconnect action', async () => {
    renderTmeetCliStatus({ stale: true });

    const card = await screen.findByTestId('saas-connector-tmeet');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.unavailable);
    expect(within(card).queryByTestId('saas-connect-tmeet')).toBeNull();
  });

  it('waits for confirmed browser opening before showing the Tencent authorization toast', async () => {
    let authorizationOpened = false;
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') {
        return Promise.resolve([{
          ...tmeetCliStatus,
          ...(authorizationOpened ? { step: 1, authorizationOpened: true } : {}),
        }]);
      }
      if (action === 'oauthConnect') return new Promise<void>(() => undefined);
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);
    const readyCard = await screen.findByTestId('saas-connector-tmeet');
    fireEvent.click(within(readyCard).getByTestId('saas-connect-tmeet'));

    expect(screen.queryByTestId('saas-connector-toast')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByTestId('saas-connector-toast')).toBeNull();

    authorizationOpened = true;
    await waitFor(() => expect(screen.getByTestId('saas-connector-toast').textContent)
      .toContain(zh.settings.saasConnectors.toast.tmeetAuthorizationOpened));
  });

  it('reports an already logged-in Tencent CLI as directly connected', async () => {
    let connected = false;
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') return Promise.resolve([{ ...tmeetCliStatus, connected }]);
      if (action === 'oauthConnect') {
        connected = true;
        return Promise.resolve({ statuses: [], alreadyConnected: true });
      }
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    const card = await screen.findByTestId('saas-connector-tmeet');
    fireEvent.click(within(card).getByTestId('saas-connect-tmeet'));

    await waitFor(() => expect(screen.getByTestId('saas-connector-toast').textContent)
      .toContain(zh.settings.saasConnectors.toast.tmeetAlreadyConnected));
  });

  it('keeps the concrete Tencent browser failure visible after status polling', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'oauthStatus') return Promise.resolve([tmeetCliStatus]);
      if (action === 'oauthConnect') return Promise.reject(new Error('browser unavailable'));
      return Promise.resolve([]);
    });
    render(<SaaSConnectorsSection />);

    const card = await screen.findByTestId('saas-connector-tmeet');
    fireEvent.click(within(card).getByTestId('saas-connect-tmeet'));

    const message = zh.settings.saasConnectors.errors.tmeetAuthorizationOpenFailed
      .replace('{reason}', 'browser unavailable');
    await screen.findByText(message);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByTestId('saas-connector-toast')).toBeNull();
  });
});

describe('SaaSConnectorsSection five card states', () => {
  it('lists Google Calendar and explains the missing injected client credential', async () => {
    renderStatus({
      id: 'google-calendar',
      displayName: 'Google Calendar',
      clientIdConfigured: false,
      requiresClientSecret: false,
    });

    const card = await screen.findByTestId('saas-connector-google-calendar');
    expect(card.textContent).toContain(zh.settings.saasConnectors.providers.googleCalendar);
    expect(card.textContent).toContain(zh.settings.saasConnectors.details.missingClientId);
    expect(within(card).queryByTestId('saas-card-action-google-calendar')).toBeNull();
    fireEvent.click(card);
    expect(within(screen.getByTestId('saas-detail-google-calendar'))
      .getByText(zh.settings.saasConnectors.details.missingClientId)).toBeTruthy();
  });

  it('keeps a connected static Google descriptor out of chat until Calendar tools exist', async () => {
    renderStatus({
      id: 'google-calendar',
      displayName: 'Google Calendar',
      clientIdConfigured: true,
      requiresClientSecret: false,
      connected: true,
    });

    const card = await screen.findByTestId('saas-connector-google-calendar');
    expect(card.textContent).toContain(zh.settings.saasConnectors.badges.connected);
    expect(within(card).queryByTestId('saas-use-in-chat-google-calendar')).toBeNull();
  });

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

  it('connecting: shows local progress without claiming the browser opened before consent', async () => {
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
      expect(screen.queryByTestId('saas-connector-toast')).toBeNull();
    });
  });

  it('connected: renders the primary use-in-chat action and keeps disconnect in the top-right icon', async () => {
    renderStatus({ clientSecretConfigured: true, connected: true });

    const card = await screen.findByTestId('saas-connector-feishu');
    expect(screen.getByTestId('saas-status-dot-feishu').className).toContain('bg-mark-success');
    const useButton = within(card).getByTestId('saas-use-in-chat-feishu');
    expect(useButton.textContent).toBe(zh.settings.saasConnectors.actions.startUsing);
    fireEvent.click(useButton);
    expect(useInChat).toHaveBeenCalledOnce();
    expect(useInChat).toHaveBeenCalledWith({ kind: 'connector', id: 'feishu' });

    fireEvent.click(within(card).getByTestId('saas-card-action-feishu'));
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.confirmTitle)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', {
      name: zh.settings.saasConnectors.disconnect.confirmTitle,
    })).getByRole('button', { name: zh.common.cancel }));
    openFeishuDetail();
    expect(screen.getByText(zh.settings.saasConnectors.disconnect.noticeWithSecret)).toBeTruthy();
    expect(screen.queryByTestId('saas-disconnect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-connect-feishu')).toBeNull();
    expect(screen.queryByTestId('saas-secret-input-feishu')).toBeNull();
  });

  it('not connected: does not render use-in-chat', async () => {
    renderStatus({ clientSecretConfigured: true, connected: false });

    await screen.findByTestId('saas-connector-feishu');
    expect(screen.queryByTestId('saas-use-in-chat-feishu')).toBeNull();
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
    fireEvent.click(screen.getByTestId('saas-card-action-feishu'));
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
