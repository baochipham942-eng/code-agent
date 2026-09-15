import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// settings.ipc.ts SETTINGS 域派发特征测试（RQ-183 续作·SETTINGS 刀迁表前钉住 switch 形态）：13 个 action。
// 既有 settings.domain.ipc.test.ts 覆盖各 action 业务行为、admin 门只测 setDevMode 与 set 的 payload 判定、
// 未知 action 只断言 code。这里补派发层契约：
// - 其余四个固定 admin action（getDevMode / setServiceApiKey / getServiceApiKey / getAllServiceKeys）被拒时原样返回门错误
// - 门在 handler 之前：configService 缺席（handler 会抛）时仍先返回门错误
// - 未知 action 不过门：非 admin 也拿 INVALID_ACTION + `Unknown action: <action>` 完整文案
// - 非 Error 抛出 → INTERNAL_ERROR + String(error)
// 迁表后（门进 handler 或 guard）本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  adminAccessError: null as IPCResponse | null,
  configNull: false,
  budgetCheck: vi.fn((): unknown => ({ used: 0 })),
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => env.adminAccessError === null,
  getAdminAccessIpcError: () => env.adminAccessError,
  assertAdminAccess: vi.fn(),
}));
vi.mock('../../../src/host/model/providerConnectionTest', () => ({ resolveConnectionTestModel: () => 'test-model' }));
vi.mock('../../../src/host/services/providerIconAssets', () => ({
  saveProviderIconAsset: vi.fn(async () => ({ icon: 'saved' })),
  resolveProviderIconAsset: vi.fn(async () => 'resolved'),
}));
vi.mock('../../../src/shared/modelRuntime', () => ({ isRuntimeProviderConfigured: () => false }));
vi.mock('../../../src/host/services/capabilities/hostCapabilityPorts', () => ({ refreshRegisteredVoiceInstructions: vi.fn() }));
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ get: vi.fn(), set: vi.fn(), getStoredApiKeyProviders: () => [] }),
}));
vi.mock('../../../src/host/services/core/budgetService', () => ({
  getBudgetService: () => ({
    checkBudget: () => env.budgetCheck(),
    getConfig: () => ({ enabled: true }),
    getCacheSavingsSummary: () => ({ cacheReadTokens: 0, cacheCreationTokens: 0, netSavedUsd: 0 }),
    getCacheCostSplitSummary: () => ({ cachedTokens: 0, uncachedTokens: 0, cachedCostUsd: 0, uncachedCostUsd: 0, cachedCostPercent: 0, uncachedCostPercent: 0 }),
    getTokenUsageSummary: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
  }),
  syncBudgetServiceFromConfig: vi.fn(),
}));
vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '9.9.9' },
  AppWindow: { getFocusedWindow: () => null },
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const config = {
  getSettings: vi.fn(() => ({})),
  updateSettings: vi.fn(async () => {}),
  setServiceApiKey: vi.fn(async () => {}),
  getServiceApiKey: vi.fn(() => undefined),
  getBudgetConfig: vi.fn(() => ({ enabled: false })),
  setBudgetConfig: vi.fn(async () => {}),
};

const denied: IPCResponse = { success: false, error: { code: 'FORBIDDEN', message: 'Settings: Admin permission required' } };

beforeEach(() => {
  vi.clearAllMocks();
  env.adminAccessError = null;
  env.configNull = false;
  env.budgetCheck.mockReturnValue({ used: 0 });
  const handlers = new Map<string, HandlerFn>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => (env.configNull ? null : (config as never)),
  );
  const handler = handlers.get(IPC_DOMAINS.SETTINGS)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('settings.ipc dispatch 特征：admin 门', () => {
  it('四个固定 admin action 被拒时原样返回门错误，且不碰 configService', async () => {
    env.adminAccessError = denied;
    expect(await call('getDevMode')).toEqual(denied);
    expect(await call('setServiceApiKey', { service: 'brave', apiKey: 'k' })).toEqual(denied);
    expect(await call('getServiceApiKey', { service: 'brave' })).toEqual(denied);
    expect(await call('getAllServiceKeys')).toEqual(denied);
    expect(config.setServiceApiKey).not.toHaveBeenCalled();
    expect(config.getServiceApiKey).not.toHaveBeenCalled();
  });

  it('门先于 handler：configService 缺席时被拒仍返回门错误而非 INTERNAL_ERROR', async () => {
    env.adminAccessError = denied;
    env.configNull = true;
    expect(await call('getAllServiceKeys')).toEqual(denied);
  });

  it('非 admin 的非门控 action 不受影响（getBudgetStatus 照常成功）', async () => {
    env.adminAccessError = denied;
    expect((await call('getBudgetStatus')).success).toBe(true);
  });
});

describe('settings.ipc dispatch 特征：兜底', () => {
  it('未知 action 不过门：非 admin 也拿 INVALID_ACTION + 完整文案', async () => {
    env.adminAccessError = denied;
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('非 Error 抛出 → INTERNAL_ERROR + String(error)', async () => {
    env.budgetCheck.mockImplementationOnce(() => { throw 'budget raw'; });
    expect(await call('getBudgetStatus')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'budget raw' } });
  });
});
