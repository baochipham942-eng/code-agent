import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  capabilityService: {
    listCapabilities: vi.fn(),
    setEnabled: vi.fn(),
    installDraft: vi.fn(),
    removeDraft: vi.fn(),
  },
  loadAllHooksConfig: vi.fn(),
  listMarketplaces: vi.fn(),
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
  }),
}));

vi.mock('../../../src/main/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => mocks.capabilityService,
}));

vi.mock('../../../src/main/hooks/configParser', () => ({
  loadAllHooksConfig: mocks.loadAllHooksConfig,
  getHooksConfigPaths: vi.fn(() => ({ global: [], project: [] })),
}));

vi.mock('../../../src/main/hooks/merger', () => ({
  mergeHooks: vi.fn(() => []),
}));

vi.mock('../../../src/main/protocol/events', () => ({
  HOOK_EVENT_DESCRIPTIONS: {
    Stop: 'Stop',
  },
}));

vi.mock('../../../src/main/platform', () => ({
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock('../../../src/main/config/configPaths', () => ({
  CONFIG_DIR_NEW: '.code-agent',
}));

vi.mock('../../../src/main/skills/marketplace', () => ({
  listMarketplaces: mocks.listMarketplaces,
  addMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
  refreshMarketplace: vi.fn(),
  getMarketplaceInfo: vi.fn(),
  listAllPlugins: vi.fn(),
  searchPlugins: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  listInstalledPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getStatus: vi.fn(),
    getTools: vi.fn(),
    getResources: vi.fn(),
    getServerStates: vi.fn(),
    getServerState: vi.fn(),
    addServer: vi.fn(),
    setServerEnabled: vi.fn(),
    reconnect: vi.fn(),
  }),
  refreshMCPServersFromCloud: vi.fn(),
}));

vi.mock('../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    clearMcpServerAcrossSessions: vi.fn(),
  }),
}));

vi.mock('../../../src/main/config', () => ({
  getMcpConfigPath: vi.fn(),
  ensureConfigDir: vi.fn(),
  pathExists: vi.fn(),
}));

import { registerCapabilityHandlers } from '../../../src/main/ipc/capability.ipc';
import { registerHookHandlers } from '../../../src/main/ipc/hook.ipc';
import { registerMarketplaceHandlers } from '../../../src/main/ipc/marketplace.ipc';
import { registerMcpHandlers } from '../../../src/main/ipc/mcp.ipc';

type HandlerFn = (_: unknown, request?: IPCRequest, ...args: unknown[]) => Promise<unknown>;

function makeFakeIpc(): { handle: Mock; invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> } {
  const registry = new Map<string, HandlerFn>();
  const handle = vi.fn((channel: string, fn: HandlerFn) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      const fn = registry.get(channel);
      if (!fn) throw new Error(`No handler registered for ${channel}`);
      return fn({}, ...(args as [IPCRequest])) as Promise<T>;
    },
  };
}

describe('admin-only IPC surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.capabilityService.listCapabilities.mockResolvedValue([]);
  });

  it('allows capability reads but blocks non-admin capability writes', async () => {
    const ipc = makeFakeIpc();
    registerCapabilityHandlers(ipc as never, {
      getConfigService: () => null,
      getAppService: () => null,
    });

    const listResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.CAPABILITY, { action: 'list' });
    const writeResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.CAPABILITY, {
      action: 'setEnabled',
      payload: { id: 'capability.demo', enabled: true },
    });

    expect(listResponse.success).toBe(true);
    expect(writeResponse).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.capabilityService.setEnabled).not.toHaveBeenCalled();
  });

  it('blocks non-admin hook raw list access before reading config files', async () => {
    const ipc = makeFakeIpc();
    registerHookHandlers(ipc as never, () => null);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.HOOK, { action: 'list' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.loadAllHooksConfig).not.toHaveBeenCalled();
  });

  it('blocks non-admin marketplace access before reading registries', async () => {
    const ipc = makeFakeIpc();
    registerMarketplaceHandlers(ipc as never);

    const response = await ipc.invoke<{ success: boolean; error?: string }>(IPC_CHANNELS.MARKETPLACE_LIST);

    expect(response).toEqual({
      success: false,
      error: 'Marketplace: Admin permission required',
    });
    expect(mocks.listMarketplaces).not.toHaveBeenCalled();
  });

  it('blocks non-admin MCP writes before touching server config', async () => {
    const ipc = makeFakeIpc();
    registerMcpHandlers(ipc as never, { getWorkingDirectory: () => '/tmp/work' });

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MCP, {
      action: 'addServer',
      payload: {
        config: {
          name: 'filesystem',
          type: 'stdio',
          command: 'npx',
        },
      },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
  });
});
