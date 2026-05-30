import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import {
  getLocalWebAuthStatus,
  installLocalWebAuthStatusHandler,
  shouldUseLocalWebAuthStatus,
} from '../../../src/web/webLocalAuth';
import {
  initializeWebPluginSystem,
  startWebCapabilityBootstrap,
} from '../../../src/web/webCapabilityBootstrap';

describe('webServer local auth status', () => {
  it('is enabled only for explicit E2E or dev API modes', () => {
    expect(shouldUseLocalWebAuthStatus({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldUseLocalWebAuthStatus({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldUseLocalWebAuthStatus({ CODE_AGENT_E2E: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldUseLocalWebAuthStatus({ CODE_AGENT_ENABLE_DEV_API: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('returns a local authenticated user for auth getStatus when installed', async () => {
    const handlerMap = new Map();
    const originalAuthHandler = vi.fn(async () => ({
      success: true,
      data: { isAuthenticated: false, user: null, isLoading: false },
    }));
    handlerMap.set(IPC_DOMAINS.AUTH, originalAuthHandler);

    const installed = installLocalWebAuthStatusHandler(
      handlerMap,
      { CODE_AGENT_E2E: '1' } as NodeJS.ProcessEnv,
    );

    expect(installed).toBe(true);
    const response = await handlerMap.get(IPC_DOMAINS.AUTH)?.(null, { action: 'getStatus' });
    expect(response).toEqual({
      success: true,
      data: getLocalWebAuthStatus(),
    });
    expect(originalAuthHandler).not.toHaveBeenCalled();
  });

  it('leaves normal web auth behavior untouched', async () => {
    const handlerMap = new Map();
    const originalAuthHandler = vi.fn(async () => ({
      success: true,
      data: { isAuthenticated: false, user: null, isLoading: false },
    }));
    handlerMap.set(IPC_DOMAINS.AUTH, originalAuthHandler);

    const installed = installLocalWebAuthStatusHandler(handlerMap, {} as NodeJS.ProcessEnv);

    expect(installed).toBe(false);
    await handlerMap.get(IPC_DOMAINS.AUTH)?.(null, { action: 'getStatus' });
    expect(originalAuthHandler).toHaveBeenCalledTimes(1);
  });

  it('delegates non-status auth actions to the registered auth handler', async () => {
    const handlerMap = new Map();
    const originalAuthHandler = vi.fn(async (_event, request) => ({
      success: true,
      data: { delegatedAction: request.action },
    }));
    handlerMap.set(IPC_DOMAINS.AUTH, originalAuthHandler);

    installLocalWebAuthStatusHandler(
      handlerMap,
      { CODE_AGENT_ENABLE_DEV_API: 'true' } as NodeJS.ProcessEnv,
    );

    const response = await handlerMap.get(IPC_DOMAINS.AUTH)?.(null, { action: 'signOut' });
    expect(response).toEqual({
      success: true,
      data: { delegatedAction: 'signOut' },
    });
    expect(originalAuthHandler).toHaveBeenCalledTimes(1);
  });
});

describe('webServer capability bootstrap', () => {
  it('initializes the protocol registry before loading plugins', async () => {
    const events: string[] = [];
    const initPluginSystem = vi.fn(async () => {
      events.push('plugins');
    });

    await initializeWebPluginSystem({
      importProtocolRegistry: async () => {
        events.push('protocolRegistry');
        return {};
      },
      importPlugins: async () => ({ initPluginSystem }),
      broadcastSSE: vi.fn(),
    });

    expect(events).toEqual(['protocolRegistry', 'plugins']);
    expect(initPluginSystem).toHaveBeenCalledTimes(1);
  });

  it('starts skill and MCP services without blocking the caller', async () => {
    const events: string[] = [];
    let releaseSkills: () => void = () => undefined;
    const configService = { getSettings: () => ({}) };
    const initializeSkills = vi.fn(() => {
      events.push('skills-started');
      return new Promise<void>((resolve) => {
        releaseSkills = () => {
          events.push('skills-finished');
          resolve();
        };
      });
    });
    const initializeMcp = vi.fn(async () => {
      events.push('mcp-started');
    });
    const initializePlugins = vi.fn(async () => {
      events.push('plugins-started');
    });

    startWebCapabilityBootstrap(configService, {
      initializeSkills,
      initializeMcp,
      initializePlugins,
    });
    events.push('caller-returned');

    expect(initializePlugins).toHaveBeenCalledTimes(1);
    expect(initializeSkills).not.toHaveBeenCalled();
    expect(initializeMcp).not.toHaveBeenCalled();
    expect(events).toEqual(['plugins-started', 'caller-returned']);

    await Promise.resolve();

    expect(initializeSkills).toHaveBeenCalledTimes(1);
    expect(initializeMcp).not.toHaveBeenCalled();
    expect(events).toEqual(['plugins-started', 'caller-returned', 'skills-started']);

    releaseSkills();
    await Promise.resolve();

    expect(initializeMcp).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['plugins-started', 'caller-returned', 'skills-started', 'skills-finished', 'mcp-started']);
  });
});
