import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import {
  getCachedCliConnectorConnectionStatus,
  replaceCliConnectorConnectionStatusCache,
} from '../../../src/host/connectors/cli/cliConnectorStatusCache';

// connector.ipc.ts 上 SaaS connector OAuth 的三个 action（oauthStatus / oauthConnect / oauthDisconnect）。
// 走 dispatch handler 而不是导出内部函数——只给单测 import 的导出会被死导出棘轮判红。

const env = vi.hoisted(() => ({
  tokens: undefined as unknown,
  secret: undefined as string | undefined,
  invalidate: vi.fn(),
  savedSecret: vi.fn(),
  larkStatus: { connected: false, identity: 'none' } as {
    connected: boolean;
    identity: string;
    stale?: boolean;
    user?: { name?: string; tenantName?: string };
  },
  larkConnect: vi.fn(),
  larkCancelConnect: vi.fn(),
  larkDisconnect: vi.fn(),
  tmeetStatus: { connected: false, identity: 'none' } as {
    connected: boolean;
    identity: string;
    stale?: boolean;
  },
  tmeetConnect: vi.fn(),
  tmeetCancelConnect: vi.fn(),
  tmeetDisconnect: vi.fn(),
}));

vi.mock('../../../src/host/connectors/feishu/larkCli', () => ({
  createLarkCliDriver: () => ({
    status: vi.fn(async () => env.larkStatus),
    connect: env.larkConnect,
    cancelConnect: env.larkCancelConnect,
    disconnect: env.larkDisconnect,
  }),
}));

vi.mock('../../../src/host/connectors/tmeet/tmeetCli', () => ({
  createTmeetCliDriver: () => ({
    status: vi.fn(async () => env.tmeetStatus),
    connect: env.tmeetConnect,
    cancelConnect: env.tmeetCancelConnect,
    disconnect: env.tmeetDisconnect,
  }),
}));

vi.mock('../../../src/host/platform/nativeShell', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../../../src/host/connectors/oauth/connectorOAuthStore', () => ({
  ConnectorOAuthStore: class {
    tokens() { return env.tokens; }
    clientSecret() { return env.secret; }
    saveClientSecret(value: string) { env.savedSecret(value); env.secret = value; }
    invalidateCredentials(scope: string) { env.invalidate(scope); }
  },
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => [],
    get: () => undefined,
    configure: vi.fn(),
    unregister: vi.fn(),
    listAvailableNativeIds: () => [],
  }),
}));

import { registerConnectorHandlers } from '../../../src/host/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function register(): HandlerFn {
  let handler: HandlerFn | undefined;
  const ipcMain = {
    handle: (channel: string, fn: HandlerFn) => {
      if (channel === IPC_DOMAINS.CONNECTOR) handler = fn;
    },
  } as unknown as Parameters<typeof registerConnectorHandlers>[0];
  registerConnectorHandlers(ipcMain, () => null, () => null);
  if (!handler) throw new Error('connector handler was not registered');
  return handler;
}

beforeEach(() => {
  replaceCliConnectorConnectionStatusCache([]);
  env.tokens = undefined;
  env.secret = undefined;
  env.invalidate.mockClear();
  env.savedSecret.mockClear();
  env.larkStatus = { connected: false, identity: 'none' };
  env.larkConnect.mockReset().mockResolvedValue({ alreadyConnected: false });
  env.larkCancelConnect.mockReset();
  env.larkDisconnect.mockReset();
  env.tmeetStatus = { connected: false, identity: 'none' };
  env.tmeetConnect.mockReset().mockResolvedValue({ alreadyConnected: false });
  env.tmeetCancelConnect.mockReset();
  env.tmeetDisconnect.mockReset();
});

describe('connector.ipc SaaS OAuth actions', () => {
  it('reports feishu through the isolated lark-cli profile', async () => {
    const handler = register();

    const before = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect(before.success).toBe(true);
    expect(before.data).toEqual([
      {
        id: 'feishu',
        displayName: '飞书',
        // client_id 内置在包里（桌面应用的 client_id 是公开值），所以恒为 true —— 若这里
        // 又依赖 env，就等于发出去的包永远报「还没配应用」。
        clientIdConfigured: true,
        requiresClientSecret: false,
        clientSecretConfigured: false,
        connected: false,
        loopbackRedirectUriSupport: 'confirmed',
        authMode: 'lark-cli',
      },
      {
        id: 'tmeet',
        displayName: '腾讯会议',
        clientIdConfigured: true,
        requiresClientSecret: false,
        clientSecretConfigured: false,
        connected: false,
        loopbackRedirectUriSupport: 'confirmed',
        authMode: 'tmeet-cli',
      },
    ]);

    env.larkStatus = {
      connected: true,
      identity: 'user',
      user: { name: 'Neo User', tenantName: 'Neo Corp' },
    };
    const after = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect((after.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      connected: true,
      userName: 'Neo User',
      tenantName: 'Neo Corp',
    });
    expect(getCachedCliConnectorConnectionStatus('feishu')).toMatchObject({ connected: true });
    expect(getCachedCliConnectorConnectionStatus('tmeet')).toMatchObject({ connected: false });
  });

  it('dispatches lark-cli logout without invalidating the custom OAuth store', async () => {
    const handler = register();
    const response = await handler(null, {
      action: 'oauthDisconnect',
      payload: { providerId: 'feishu' },
    } as IPCRequest);

    expect(response.success).toBe(true);
    expect(env.larkDisconnect).toHaveBeenCalledOnce();
    expect(env.invalidate).not.toHaveBeenCalled();
  });

  it('preserves an unknown CLI probe as stale instead of reporting confirmed logout', async () => {
    env.tmeetStatus = { connected: false, identity: 'none', stale: true };
    const handler = register();

    const response = await handler(null, { action: 'oauthStatus' } as IPCRequest);

    expect((response.data as Array<Record<string, unknown>>)[1]).toMatchObject({
      connected: false,
      stale: true,
    });
  });

  it('publishes the current lark-cli connection step through oauthStatus', async () => {
    let finishConnect: (() => void) | undefined;
    env.larkConnect.mockImplementation(async (
      _openExternal: unknown,
      onStep: (step: 1 | 2) => void,
    ) => {
      onStep(2);
      await new Promise<void>((resolve) => { finishConnect = resolve; });
      return { alreadyConnected: false };
    });
    const handler = register();
    const connectPromise = handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'feishu', action: 'message.send-as-user' },
    } as IPCRequest);

    await vi.waitFor(() => expect(env.larkConnect).toHaveBeenCalledOnce());
    const during = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect((during.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      authMode: 'lark-cli',
      connected: false,
      step: 2,
    });

    finishConnect?.();
    await connectPromise;
  });

  it('returns a stable ADMIN_REQUIRED code and persists the blocked status for retry UI', async () => {
    env.larkConnect.mockRejectedValueOnce(new Error('需联系企业应用管理员安装'));
    const handler = register();

    const response = await handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'feishu', action: 'message.send-as-user' },
    } as IPCRequest);
    expect(response).toMatchObject({
      success: false,
      error: { code: 'ADMIN_REQUIRED', message: '需联系企业应用管理员安装' },
    });
    const blocked = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect((blocked.data as Array<Record<string, unknown>>)[0]).toMatchObject({ blocked: true });

    await handler(null, {
      action: 'oauthDisconnect',
      payload: { providerId: 'feishu' },
    } as IPCRequest);
  });

  it('routes connection cancellation to the active lark-cli driver', async () => {
    const handler = register();

    const response = await handler(null, {
      action: 'oauthCancelConnect',
      payload: { providerId: 'feishu' },
    } as IPCRequest);

    expect(response.success).toBe(true);
    expect(env.larkCancelConnect).toHaveBeenCalledOnce();
  });

  it('dispatches connect to lark-cli instead of the built-in OAuth coordinator', async () => {
    const handler = register();
    const response = await handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'feishu', action: 'message.send-as-user' },
    } as IPCRequest);

    expect(response.success).toBe(true);
    expect(env.larkConnect).toHaveBeenCalledOnce();
  });

  it('publishes Tencent Meeting as a one-step tmeet CLI connection', async () => {
    let finishConnect: (() => void) | undefined;
    env.tmeetConnect.mockImplementation(async (
      _openExternal: unknown,
      onStep: (step: 1 | 2) => void,
      onAuthorizationOpened: () => void,
    ) => {
      onStep(1);
      onAuthorizationOpened();
      await new Promise<void>((resolve) => { finishConnect = resolve; });
      return { alreadyConnected: false };
    });
    const handler = register();
    const connectPromise = handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'tmeet', action: 'meeting.create', authMode: 'tmeet-cli' },
    } as IPCRequest);

    await vi.waitFor(() => expect(env.tmeetConnect).toHaveBeenCalledOnce());
    const during = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect((during.data as Array<Record<string, unknown>>)[1]).toMatchObject({
      authMode: 'tmeet-cli',
      connected: false,
      step: 1,
      authorizationOpened: true,
    });

    finishConnect?.();
    await connectPromise;
  });

  it('routes Tencent Meeting cancellation and logout to the tmeet CLI driver', async () => {
    const handler = register();

    await handler(null, {
      action: 'oauthCancelConnect',
      payload: { providerId: 'tmeet' },
    } as IPCRequest);
    await handler(null, {
      action: 'oauthDisconnect',
      payload: { providerId: 'tmeet' },
    } as IPCRequest);

    expect(env.tmeetCancelConnect).toHaveBeenCalledOnce();
    expect(env.tmeetDisconnect).toHaveBeenCalledOnce();
  });

  it('returns the direct-connect fact when Tencent Meeting was already logged in', async () => {
    env.tmeetStatus = { connected: true, identity: 'user' };
    env.tmeetConnect.mockResolvedValue({ alreadyConnected: true });
    const handler = register();

    const response = await handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'tmeet', action: 'meeting.create', authMode: 'tmeet-cli' },
    } as IPCRequest);

    expect(response.data).toMatchObject({
      alreadyConnected: true,
      statuses: expect.any(Array),
    });
  });

  it('rejects an unknown provider instead of silently doing nothing', async () => {
    const handler = register();
    const response = await handler(null, {
      action: 'oauthConnect',
      payload: { providerId: 'notion' },
    } as IPCRequest);

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('notion');
    expect(env.invalidate).not.toHaveBeenCalled();
  });
});

describe('connector.ipc SaaS OAuth client secret', () => {
  it('rejects App Secret writes for the lark-cli provider', async () => {
    const handler = register();

    const response = await handler(null, {
      action: 'oauthSetSecret',
      payload: { providerId: 'feishu', clientSecret: '  s3cret  ' },
    } as IPCRequest);

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('不需要 App Secret');
    expect(env.savedSecret).not.toHaveBeenCalled();
  });

  it('never exposes a custom OAuth secret route for Tencent Meeting', async () => {
    const handler = register();

    const response = await handler(null, {
      action: 'oauthSetSecret',
      payload: { providerId: 'tmeet', clientSecret: 'do-not-save', authMode: 'oauth' },
    } as IPCRequest);

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('does not use an App Secret');
    expect(env.savedSecret).not.toHaveBeenCalled();
  });

  it('keeps the existing custom-app secret route available when explicitly selected', async () => {
    const handler = register();

    const response = await handler(null, {
      action: 'oauthSetSecret',
      payload: { providerId: 'feishu', clientSecret: 'custom-secret', authMode: 'oauth' },
    } as IPCRequest);

    expect(response.success).toBe(true);
    expect(env.savedSecret).toHaveBeenCalledWith('custom-secret');
  });

  it('refuses an empty secret instead of storing a blank credential', async () => {
    const handler = register();

    const response = await handler(null, {
      action: 'oauthSetSecret',
      payload: { providerId: 'feishu', clientSecret: '   ' },
    } as IPCRequest);

    expect(response.success).toBe(false);
    expect(env.savedSecret).not.toHaveBeenCalled();
  });
});
