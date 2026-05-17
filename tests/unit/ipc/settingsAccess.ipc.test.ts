import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import type { AppSettings } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
  }),
}));

vi.mock('../../../src/main/platform', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0-test'),
  },
}));

import { registerSettingsHandlers } from '../../../src/main/ipc/settings.ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.SETTINGS);
      if (!fn) throw new Error('SETTINGS handler not registered');
      return fn;
    },
  };
}

function makeSettings(): AppSettings {
  return {
    models: {
      default: 'gpt-4o',
      defaultProvider: 'openai',
      providers: {
        openai: { enabled: true, model: 'gpt-4o', apiKey: 'sk-openai-secret' },
        claude: { enabled: false },
        deepseek: { enabled: false },
        gemini: { enabled: false },
        groq: { enabled: false },
        local: { enabled: false },
        zhipu: { enabled: false },
        qwen: { enabled: false },
        moonshot: { enabled: false },
        minimax: { enabled: false },
        perplexity: { enabled: false },
        openrouter: { enabled: false },
        xiaomi: { enabled: false },
      },
      routing: {
        code: { provider: 'openai', model: 'gpt-4o' },
        vision: { provider: 'openai', model: 'gpt-4o' },
        fast: { provider: 'openai', model: 'gpt-4o-mini' },
        gui: { provider: 'openai', model: 'gpt-4o' },
      },
    },
    generation: {},
    workspace: { recentDirectories: [] },
    permissions: {
      autoApprove: {},
      blockedCommands: ['rm -rf *'],
      devModeAutoApprove: true,
      permissionMode: 'bypassPermissions',
      deny: ['Bash(rm -rf *)'],
      ask: ['Write(*)'],
      allow: ['Read(*)'],
      _legacyPermissions: true,
    },
    ui: {
      theme: 'dark',
      fontSize: 14,
      showToolCalls: true,
      language: 'zh',
    },
    cloud: {
      enabled: true,
      endpoint: 'https://cloud.example.com',
      apiKey: 'cloud-secret',
      warmupOnInit: false,
    },
    guiAgent: {
      enabled: false,
      displayWidth: 1280,
      displayHeight: 720,
    },
    mcp: {
      servers: [{
        name: 'private',
        command: 'npx',
        env: { TOKEN: 'secret' },
        enabled: true,
      }],
    },
    langfuse: {
      publicKey: 'pk',
      secretKey: 'sk-langfuse',
      enabled: true,
    },
    budget: {
      enabled: true,
      monthlyLimit: 10,
      currentUsage: 5,
      alertThreshold: 0.8,
    },
  } as AppSettings;
}

describe('settings.ipc access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
  });

  it('sanitizes raw secrets and policies for non-admin settings reads', async () => {
    const ipc = makeFakeIpc();
    registerSettingsHandlers(ipc as never, () => ({ getSettings: () => makeSettings() }) as never);

    const response = await ipc.getHandler()({}, { action: 'get' });

    expect(response.success).toBe(true);
    const settings = response.data as AppSettings;
    expect(settings.models.providers.openai.apiKey).toBeUndefined();
    expect(settings.cloud.apiKey).toBeUndefined();
    expect(settings.langfuse?.secretKey).toBeUndefined();
    expect(settings.mcp).toBeUndefined();
    expect(settings.budget).toBeUndefined();
    expect(settings.permissions.devModeAutoApprove).toBe(false);
    expect(settings.permissions.permissionMode).toBe('default');
    expect(settings.permissions.deny).toBeUndefined();
  });

  it('blocks non-admin writes to global security settings', async () => {
    const updateSettings = vi.fn();
    const ipc = makeFakeIpc();
    registerSettingsHandlers(ipc as never, () => ({ updateSettings }) as never);

    const response = await ipc.getHandler()({}, {
      action: 'set',
      payload: { settings: { permissions: { permissionMode: 'bypassPermissions' } } },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('allows non-admin writes to productized personal UI settings', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const ipc = makeFakeIpc();
    registerSettingsHandlers(ipc as never, () => ({ updateSettings }) as never);

    const response = await ipc.getHandler()({}, {
      action: 'set',
      payload: { settings: { ui: { theme: 'light' } } },
    });

    expect(response.success).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({ ui: { theme: 'light' } });
  });

  it('allows non-admin model provider setup for onboarding', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const ipc = makeFakeIpc();
    registerSettingsHandlers(ipc as never, () => ({ updateSettings }) as never);

    const response = await ipc.getHandler()({}, {
      action: 'set',
      payload: {
        settings: {
          models: {
            default: 'deepseek',
            defaultProvider: 'deepseek',
            providers: {
              deepseek: {
                enabled: true,
                apiKey: 'sk-user-model-key',
                baseUrl: 'https://api.deepseek.com/v1',
                model: 'deepseek-v4-flash',
              },
            },
          },
        },
      },
    });

    expect(response.success).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({
      models: {
        default: 'deepseek',
        defaultProvider: 'deepseek',
        providers: {
          deepseek: {
            enabled: true,
            apiKey: 'sk-user-model-key',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-flash',
          },
        },
      },
    });
  });
});
