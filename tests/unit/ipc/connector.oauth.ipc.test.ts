import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// connector.ipc.ts 上 SaaS connector OAuth 的三个 action（oauthStatus / oauthConnect / oauthDisconnect）。
// 走 dispatch handler 而不是导出内部函数——只给单测 import 的导出会被死导出棘轮判红。

const env = vi.hoisted(() => ({
  tokens: undefined as unknown,
  invalidate: vi.fn(),
}));

vi.mock('../../../src/host/connectors/oauth/connectorOAuthStore', () => ({
  ConnectorOAuthStore: class {
    tokens() { return env.tokens; }
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
  env.tokens = undefined;
  env.invalidate.mockClear();
});

describe('connector.ipc SaaS OAuth actions', () => {
  it('reports feishu as disconnected until the connector-oauth store holds tokens', async () => {
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
        connected: false,
        loopbackRedirectUriSupport: 'confirmed',
      },
    ]);

    env.tokens = { tokens: { access_token: 'a' }, requestedScope: 'im:message', expiresAt: 0 };
    const after = await handler(null, { action: 'oauthStatus' } as IPCRequest);
    expect((after.data as Array<{ connected: boolean }>)[0]?.connected).toBe(true);
  });

  it('wipes every stored credential on disconnect', async () => {
    const handler = register();
    const response = await handler(null, {
      action: 'oauthDisconnect',
      payload: { providerId: 'feishu' },
    } as IPCRequest);

    expect(response.success).toBe(true);
    expect(env.invalidate).toHaveBeenCalledWith('all');
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
