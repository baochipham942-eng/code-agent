import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const platformMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    BrowserWindow: class MockBrowserWindow {
      webContents = { send: vi.fn() };
    },
    onRendererPush: vi.fn(),
  };
});

const pluginBootstrapMock = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    initPluginSystem: vi.fn(async () => {
      events.push('plugins');
    }),
  };
});

vi.mock('../../../src/main/platform', () => platformMock);
vi.mock('electron', () => ({
  ...platformMock,
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/code-agent-test'),
    getName: vi.fn(() => 'code-agent-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
  },
}));
vi.mock('../../../src/main/tools/protocolRegistry', () => {
  pluginBootstrapMock.events.push('protocolRegistry');
  return {};
});
vi.mock('../../../src/main/plugins', () => ({
  initPluginSystem: pluginBootstrapMock.initPluginSystem,
}));

type WebServerAuthModule = typeof import('../../../src/web/webServer');

let webServerAuth: Pick<
  WebServerAuthModule,
  | 'getLocalWebAuthStatus'
  | 'installLocalWebAuthStatusHandler'
  | 'shouldUseLocalWebAuthStatus'
  | 'startWebCapabilityBootstrap'
  | 'initializeWebPluginSystem'
>;

beforeAll(async () => {
  webServerAuth = await import('../../../src/web/webServer');
});

describe('webServer local auth status', () => {
  it('is enabled only for explicit E2E or dev API modes', () => {
    expect(webServerAuth.shouldUseLocalWebAuthStatus({} as NodeJS.ProcessEnv)).toBe(false);
    expect(webServerAuth.shouldUseLocalWebAuthStatus({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(webServerAuth.shouldUseLocalWebAuthStatus({ CODE_AGENT_E2E: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(webServerAuth.shouldUseLocalWebAuthStatus({ CODE_AGENT_ENABLE_DEV_API: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('returns a local authenticated user for auth getStatus when installed', async () => {
    const handlerMap = new Map();
    const originalAuthHandler = vi.fn(async () => ({
      success: true,
      data: { isAuthenticated: false, user: null, isLoading: false },
    }));
    handlerMap.set(IPC_DOMAINS.AUTH, originalAuthHandler);

    const installed = webServerAuth.installLocalWebAuthStatusHandler(
      handlerMap,
      { CODE_AGENT_E2E: '1' } as NodeJS.ProcessEnv,
    );

    expect(installed).toBe(true);
    const response = await handlerMap.get(IPC_DOMAINS.AUTH)?.(null, { action: 'getStatus' });
    expect(response).toEqual({
      success: true,
      data: webServerAuth.getLocalWebAuthStatus(),
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

    const installed = webServerAuth.installLocalWebAuthStatusHandler(handlerMap, {} as NodeJS.ProcessEnv);

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

    webServerAuth.installLocalWebAuthStatusHandler(
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
    pluginBootstrapMock.events.length = 0;
    pluginBootstrapMock.initPluginSystem.mockClear();

    await webServerAuth.initializeWebPluginSystem();

    expect(pluginBootstrapMock.events).toEqual(['protocolRegistry', 'plugins']);
    expect(pluginBootstrapMock.initPluginSystem).toHaveBeenCalledTimes(1);
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

    webServerAuth.startWebCapabilityBootstrap(configService, {
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
