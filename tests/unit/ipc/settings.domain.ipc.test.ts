import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// settings.ipc.ts 的 SETTINGS / WINDOW domain dispatch 覆盖（文档解析 handler 是外部
// 工具壳，低价值不测）。重点：admin 门控（admin-only action 拦截 + 非 admin 读取脱敏
// sanitizeSettingsForUser）、testApiKey 各 provider/错误分支、service key 掩码、budget
// payload 归一化。mock adminGuard/secureStorage/budgetService/providerIconAssets/fetch/platform。

const env = vi.hoisted(() => ({
  isAdmin: true,
  adminAccessError: null as IPCResponse | null,
  config: {
    getSettings: vi.fn(() => ({}) as Record<string, unknown>),
    updateSettings: vi.fn(async () => {}),
    setServiceApiKey: vi.fn(async () => {}),
    getServiceApiKey: vi.fn((_s: string) => undefined as string | undefined),
    getBudgetConfig: vi.fn(() => ({ enabled: false })),
    setBudgetConfig: vi.fn(async () => {}),
  },
  configNull: false,
  secureStorage: {
    get: vi.fn((_k: string) => undefined as string | undefined),
    set: vi.fn(),
    getStoredApiKeyProviders: vi.fn((): string[] => []),
  },
  budget: { checkBudget: vi.fn(() => ({ used: 0 })), getConfig: vi.fn(() => ({ enabled: true })) },
  syncBudget: vi.fn(),
  saveIcon: vi.fn(async () => ({ icon: 'saved' })),
  resolveIcon: vi.fn(async () => 'resolved'),
  runtimeConfigured: vi.fn(() => false),
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => env.isAdmin,
  getAdminAccessIpcError: () => env.adminAccessError,
  assertAdminAccess: vi.fn(),
}));
vi.mock('../../../src/host/model/providerConnectionTest', () => ({
  resolveConnectionTestModel: () => 'test-model',
}));
vi.mock('../../../src/host/services/providerIconAssets', () => ({
  saveProviderIconAsset: (...a: unknown[]) => env.saveIcon(...a),
  resolveProviderIconAsset: (...a: unknown[]) => env.resolveIcon(...a),
}));
vi.mock('../../../src/shared/modelRuntime', () => ({
  isRuntimeProviderConfigured: (...a: unknown[]) => env.runtimeConfigured(...a),
}));
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => env.secureStorage,
}));
vi.mock('../../../src/host/services/core/budgetService', () => ({
  getBudgetService: () => env.budget,
  syncBudgetServiceFromConfig: (...a: unknown[]) => env.syncBudget(...a),
}));
vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '9.9.9' },
  AppWindow: { getFocusedWindow: () => null },
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

let handlers: Map<string, HandlerFn>;
function callSettings(action: string, payload?: unknown) {
  return handlers.get(IPC_DOMAINS.SETTINGS)!(null, { action, payload } as IPCRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.isAdmin = true;
  env.adminAccessError = null;
  env.configNull = false;
  env.config.getSettings.mockReturnValue({});
  env.config.updateSettings.mockResolvedValue(undefined);
  env.config.getServiceApiKey.mockReturnValue(undefined);
  env.config.getBudgetConfig.mockReturnValue({ enabled: false });
  env.secureStorage.get.mockReturnValue(undefined);
  env.secureStorage.getStoredApiKeyProviders.mockReturnValue([]);
  env.runtimeConfigured.mockReturnValue(false);
  handlers = new Map<string, HandlerFn>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => (env.configNull ? null : (env.config as never)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin 门控', () => {
  it('admin-only action（setDevMode）在 access 被拒时返回该错误', async () => {
    env.adminAccessError = { success: false, error: { code: 'ADMIN_REQUIRED', message: 'no' } };
    expect(await callSettings('setDevMode', { enabled: true })).toEqual(env.adminAccessError);
  });

  it("set 含 admin-only key（permissions）触发门控", async () => {
    env.adminAccessError = { success: false, error: { code: 'ADMIN_REQUIRED', message: 'no' } };
    expect(await callSettings('set', { settings: { permissions: {} } })).toEqual(env.adminAccessError);
  });

  it('set 仅含普通 key 不触发门控', async () => {
    env.adminAccessError = { success: false, error: { code: 'ADMIN_REQUIRED', message: 'no' } };
    const res = await callSettings('set', { settings: { theme: 'dark' } as never });
    expect(res.success).toBe(true);
    expect(env.config.updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });
});

describe('get + 脱敏', () => {
  const rich = {
    models: { providers: { openai: { apiKey: 'sk-secret', enabled: true }, kimi: { managedByCloud: true } } },
    cloud: { apiKey: 'cloud-secret' },
    langfuse: { secretKey: 'lf-secret', publicKey: 'pk' },
    mcp: { servers: [] },
    budget: { enabled: true },
    permissions: { permissionMode: 'bypassPermissions', devModeAutoApprove: true, blockedCommands: ['rm'], deny: ['x'] },
  };

  it('admin 读取拿到完整设置（不脱敏）', async () => {
    env.isAdmin = true;
    env.config.getSettings.mockReturnValue(rich);
    const data = (await callSettings('get')).data as typeof rich;
    expect(data.models.providers.openai.apiKey).toBe('sk-secret');
    expect(data.mcp).toBeDefined();
  });

  it('非 admin 读取被脱敏：抹 key、删 mcp/budget、降权 permissions', async () => {
    env.isAdmin = false;
    env.config.getSettings.mockReturnValue(rich);
    const data = (await callSettings('get')).data as Record<string, never>;
    const providers = (data as never as typeof rich).models.providers;
    expect(providers.openai.apiKey).toBeUndefined();
    expect(providers.openai.apiKeyConfigured).toBe(true); // 有过 key → configured
    expect(providers.kimi.apiKeyConfigured).toBe(true); // managedByCloud → configured
    expect((data as never as typeof rich).cloud.apiKey).toBeUndefined();
    expect((data as never as typeof rich).langfuse.secretKey).toBeUndefined();
    expect((data as Record<string, unknown>).mcp).toBeUndefined();
    expect((data as Record<string, unknown>).budget).toBeUndefined();
    const perms = (data as never as typeof rich).permissions;
    expect(perms.permissionMode).toBe('default'); // bypassPermissions 被降级
    expect(perms.devModeAutoApprove).toBe(false);
    expect(perms.blockedCommands).toEqual([]);
    expect((perms as Record<string, unknown>).deny).toBeUndefined();
  });
});

describe('testApiKey', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('不支持的 provider → success:false', async () => {
    const res = (await callSettings('testApiKey', { provider: 'unknown', apiKey: 'k' })).data as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('不支持');
  });

  it('deepseek 200 → GET /models + Bearer 鉴权头', async () => {
    global.fetch = vi.fn(async () => ({ ok: true })) as never;
    expect((await callSettings('testApiKey', { provider: 'deepseek', apiKey: 'k' })).data).toEqual({ success: true });
    // Codex 审计：不能只看 method——验证打的是 /models 端点、带正确 Bearer 头、GET 无 body
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { method: string; headers: Record<string, string>; body?: unknown }];
    expect(url).toContain('/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(init.body).toBeUndefined();
  });

  it('claude → POST /messages + x-api-key + anthropic-version + JSON body', async () => {
    global.fetch = vi.fn(async () => ({ ok: true })) as never;
    await callSettings('testApiKey', { provider: 'claude', apiKey: 'k' });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toContain('/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('k');
    expect(init.headers['anthropic-version']).toBeTruthy();
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
  });

  it('非 200 → 返回状态码与截断错误文本', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })) as never;
    const res = (await callSettings('testApiKey', { provider: 'openai', apiKey: 'k' })).data as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('401');
  });

  it('fetch 抛错 → 连接失败', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONN');
    }) as never;
    const res = (await callSettings('testApiKey', { provider: 'groq', apiKey: 'k' })).data as { success: boolean; error: string };
    expect(res.error).toContain('连接失败');
  });
});

describe('devMode', () => {
  it('getDevMode 未设过默认 true', async () => {
    env.secureStorage.get.mockReturnValue(undefined);
    expect((await callSettings('getDevMode')).data).toBe(true);
  });

  it('getDevMode 读 secureStorage 字符串值', async () => {
    env.secureStorage.get.mockReturnValue('false');
    expect((await callSettings('getDevMode')).data).toBe(false);
  });

  it('setDevMode 写 secureStorage 并把 devModeAutoApprove 同步进 config（保留既有 permissions）', async () => {
    env.config.getSettings.mockReturnValue({ permissions: { permissionMode: 'default' } });
    await callSettings('setDevMode', { enabled: true });
    expect(env.secureStorage.set).toHaveBeenCalledWith('settings.devModeAutoApprove', 'true');
    // Codex 审计：同步点是 payload 本身——丢掉既有 permissions 或没写 devModeAutoApprove 不能绿
    expect(env.config.updateSettings).toHaveBeenCalledWith({ permissions: { permissionMode: 'default', devModeAutoApprove: true } });
  });
});

describe('checkApiKeyConfigured', () => {
  it('provider 运行时已配置 → true', async () => {
    env.config.getSettings.mockReturnValue({ models: { providers: { openai: { enabled: true } } } });
    env.runtimeConfigured.mockReturnValue(true);
    expect((await callSettings('checkApiKeyConfigured')).data).toBe(true);
  });

  it('secureStorage 有存储的 key → true', async () => {
    env.config.getSettings.mockReturnValue({});
    env.secureStorage.getStoredApiKeyProviders.mockReturnValue(['openai']);
    expect((await callSettings('checkApiKeyConfigured')).data).toBe(true);
  });

  it('全无 → false', async () => {
    const saved = process.env;
    process.env = { ...saved };
    try {
      for (const k of ['MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ZHIPU_API_KEY', 'GROQ_API_KEY', 'QWEN_API_KEY', 'MINIMAX_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY', 'LONGCAT_API_KEY', 'XIAOMI_API_KEY']) {
        delete process.env[k];
      }
      env.config.getSettings.mockReturnValue({});
      expect((await callSettings('checkApiKeyConfigured')).data).toBe(false);
    } finally {
      // Codex 审计：断言失败也要还原 env，否则污染后续测试
      process.env = saved;
    }
  });
});

describe('provider 图标', () => {
  it('saveProviderIconAsset 委派', async () => {
    expect((await callSettings('saveProviderIconAsset', { provider: 'openai', dataUrl: 'data:...' })).data).toEqual({ icon: 'saved' });
    expect(env.saveIcon).toHaveBeenCalledWith({ provider: 'openai', dataUrl: 'data:...' });
  });

  it('resolveProviderIconAsset 委派', async () => {
    expect((await callSettings('resolveProviderIconAsset', { icon: 'x' })).data).toBe('resolved');
  });
});

describe('service api keys', () => {
  it('setServiceApiKey / getServiceApiKey 委派 configService', async () => {
    env.config.getServiceApiKey.mockReturnValue('secret');
    await callSettings('setServiceApiKey', { service: 'brave', apiKey: 'k' });
    expect(env.config.setServiceApiKey).toHaveBeenCalledWith('brave', 'k');
    expect((await callSettings('getServiceApiKey', { service: 'brave' })).data).toBe('secret');
  });

  it('getAllServiceKeys 对长 key 做掩码（前 8 位 + ...）', async () => {
    env.config.getServiceApiKey.mockImplementation((s: string) => (s === 'firecrawl' ? 'fc-1234567890abcdef' : undefined));
    const data = (await callSettings('getAllServiceKeys')).data as Record<string, string>;
    expect(data.firecrawl).toBe('fc-12345...');
    expect(data.brave).toBeUndefined();
  });

  it('config 为 null → INTERNAL_ERROR', async () => {
    env.configNull = true;
    handlers = new Map<string, HandlerFn>();
    registerSettingsHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never, () => null);
    expect(await callSettings('getAllServiceKeys')).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('budget', () => {
  it('getBudgetStatus 合并 check + config', async () => {
    expect((await callSettings('getBudgetStatus')).data).toEqual({ used: 0, config: { enabled: true } });
  });

  it('setBudgetConfig 从 {budget:{...}} 提取并同步运行时', async () => {
    await callSettings('setBudgetConfig', { budget: { enabled: true, limit: 100 } });
    expect(env.config.setBudgetConfig).toHaveBeenCalledWith({ enabled: true, limit: 100 });
    expect(env.syncBudget).toHaveBeenCalled();
  });

  it('setBudgetConfig 接受扁平 payload', async () => {
    await callSettings('setBudgetConfig', { enabled: false });
    expect(env.config.setBudgetConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('setBudgetConfig 畸形 payload（null）不抛', async () => {
    await callSettings('setBudgetConfig', null);
    expect(env.config.setBudgetConfig).toHaveBeenCalledWith({});
  });
});

describe('未知 action 与 WINDOW domain', () => {
  it('未知 settings action → INVALID_ACTION', async () => {
    expect(await callSettings('bogus')).toMatchObject({ success: false, error: { code: 'INVALID_ACTION' } });
  });

  it('WINDOW domain 无聚焦窗口时各 action 安全返回', async () => {
    const winHandler = handlers.get(IPC_DOMAINS.WINDOW)!;
    expect(await winHandler(null, { action: 'minimize' } as IPCRequest)).toEqual({ success: true, data: null });
    expect(await winHandler(null, { action: 'maximize' } as IPCRequest)).toEqual({ success: true, data: null });
    expect(await winHandler(null, { action: 'close' } as IPCRequest)).toEqual({ success: true, data: null });
    expect(await winHandler(null, { action: 'nope' } as IPCRequest)).toMatchObject({ success: false, error: { code: 'INVALID_ACTION' } });
  });
});
