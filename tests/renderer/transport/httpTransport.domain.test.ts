import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));

vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: 'test-token',
};

import { createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { DEFAULT_OPENCHRONICLE_SETTINGS } from '../../../src/shared/contract/openchronicle';

describe('httpTransport domain API', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('routes OpenChronicle actions through the HTTP domain endpoint used by Tauri', async () => {
    const api = createHttpDomainAPI('http://localhost:8180');
    const actions = [
      { action: 'getSettings', payload: undefined },
      { action: 'getStatus', payload: undefined },
      { action: 'setEnabled', payload: { enabled: true } },
      { action: 'updateSettings', payload: DEFAULT_OPENCHRONICLE_SETTINGS },
    ];

    for (const item of actions) {
      await api.invoke(IPC_DOMAINS.OPENCHRONICLE, item.action, item.payload);
    }

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(actions.length);
    for (const [index, item] of actions.entries()) {
      const [url, init] = fetchMock.mock.calls[index];
      const requestInit = init as RequestInit;
      expect(url).toBe(`http://localhost:8180/api/domain/openchronicle/${item.action}`);
      expect(requestInit).toMatchObject({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
      });
      const body = JSON.parse(String(requestInit.body));
      expect(body.action).toBe(item.action);
      if (item.payload !== undefined) {
        expect(body.payload).toEqual(item.payload);
      }
    }
  });

  it('routes Activity provider actions through the HTTP domain endpoint used by Tauri', async () => {
    const api = createHttpDomainAPI('http://localhost:8180');

    await api.invoke(IPC_DOMAINS.ACTIVITY, 'listProviders');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    const requestInit = init as RequestInit;
    expect(url).toBe('http://localhost:8180/api/domain/activity/listProviders');
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
    });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      action: 'listProviders',
    });
  });

});
