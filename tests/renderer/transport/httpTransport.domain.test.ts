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

import { createHttpCodeAgentAPI, createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
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

  it('routes agent interrupt through the web runtime interrupt endpoint', async () => {
    const api = createHttpDomainAPI('http://localhost:8180');
    const payload = {
      content: '补一句',
      sessionId: 'session-running',
      clientMessageId: 'client-msg-1',
      context: {
        runtimeInput: { mode: 'supplement' },
      },
    };

    await api.invoke(IPC_DOMAINS.AGENT, 'interrupt', payload);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    const requestInit = init as RequestInit;
    expect(url).toBe('http://localhost:8180/api/interrupt');
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
    });
    expect(JSON.parse(String(requestInit.body))).toEqual(payload);
  });

  it('routes agent pause and resume through web runtime endpoints', async () => {
    const api = createHttpDomainAPI('http://localhost:8180');
    const payload = { sessionId: 'session-paused' };

    await api.invoke(IPC_DOMAINS.AGENT, 'pause', payload);
    await api.invoke(IPC_DOMAINS.AGENT, 'resume', payload);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8180/api/pause');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual(payload);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8180/api/resume');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual(payload);
  });

  it('forwards clientMessageId for SSE-backed chat sends', async () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke('agent:send-message', {
      content: 'hello',
      sessionId: 'session-chat',
      clientMessageId: 'client-msg-chat',
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    const requestInit = init as RequestInit;
    expect(url).toBe('http://localhost:8180/api/run');
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
    });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      prompt: 'hello',
      sessionId: 'session-chat',
      clientMessageId: 'client-msg-chat',
    });
  });

  it('promotes goal options to the /api/run goal contract for web sends', async () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke('agent:send-message', {
      content: '修好登录',
      sessionId: 'session-goal',
      options: {
        goal: {
          goal: '修好登录',
          verify: 'npm test',
          maxTurns: 4,
          budget: 2000,
        },
      },
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      prompt: '修好登录',
      sessionId: 'session-goal',
      goal: {
        goal: '修好登录',
        verify: 'npm test',
        maxTurns: 4,
        budget: 2000,
      },
    });
  });

});
