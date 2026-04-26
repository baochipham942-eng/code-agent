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

import { getTransportMode, initTransport, setApiUrl } from '../../../src/renderer/api';

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
    },
  });
}

function installWindow(value: Record<string, unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { origin: 'http://localhost:8180', search: '' },
      ...value,
    },
  });
}

describe('renderer transport bootstrap', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('installs neutral Code Agent APIs and legacy aliases for HTTP mode', () => {
    installWindow({});

    initTransport();

    expect(window.__CODE_AGENT_HTTP_BRIDGE__).toBe(true);
    expect(window.codeAgentAPI).toBeDefined();
    expect(window.codeAgentDomainAPI).toBeDefined();
    expect(window.electronAPI).toBe(window.codeAgentAPI);
    expect(window.domainAPI).toBe(window.codeAgentDomainAPI);
    expect(getTransportMode()).toBe('http');
  });

  it('keeps native bridge mode when a preload API already exists', () => {
    const commandBridge = { invoke: vi.fn() };
    const domainBridge = { invoke: vi.fn() };
    installWindow({
      codeAgentAPI: commandBridge,
      codeAgentDomainAPI: domainBridge,
    });

    initTransport();

    expect(window.__CODE_AGENT_HTTP_BRIDGE__).toBeUndefined();
    expect(window.codeAgentAPI).toBe(commandBridge);
    expect(window.codeAgentDomainAPI).toBe(domainBridge);
    expect(getTransportMode()).toBe('native');
  });

  it('setApiUrl refreshes the neutral APIs and compatibility aliases', () => {
    installWindow({});

    setApiUrl('http://localhost:9999');

    expect(localStorage.setItem).toHaveBeenCalledWith('code-agent-api-url', 'http://localhost:9999');
    expect(window.__CODE_AGENT_HTTP_BRIDGE__).toBe(true);
    expect(window.electronAPI).toBe(window.codeAgentAPI);
    expect(window.domainAPI).toBe(window.codeAgentDomainAPI);
  });
});
