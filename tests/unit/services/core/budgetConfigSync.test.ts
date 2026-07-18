import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../../../src/host/services/core/configService';

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

async function loadModules(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockClear();
  vi.doMock('../../../../src/host/platform', () => ({
    app: { isPackaged: false, getPath: (_n: string) => dataDir },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/host/services/infra/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));
  vi.doMock('../../../../src/host/permissions/policyEngine', () => ({
    getPolicyEngine: () => ({ loadUserRules: vi.fn() }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({ setProviderConcurrencyOverrides: vi.fn() }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({ setProviderProxyOverrides: vi.fn() }));
  return {
    configModule: await import('../../../../src/host/services/core/configService'),
    budgetModule: await import('../../../../src/host/services/core/budgetService'),
  };
}

// 复现 settings.ipc.ts setBudgetConfig handler 的核心序列：持久化 + 同步运行时单例。
async function applyBudgetUpdate(
  configService: Pick<ConfigService, 'setBudgetConfig' | 'getBudgetConfig'>,
  budgetModule: { syncBudgetServiceFromConfig: (c: never) => void; getBudgetService: () => { getConfig: () => { maxBudget: number; enabled: boolean } } },
  budget: Record<string, unknown>,
): Promise<void> {
  await configService.setBudgetConfig(budget);
  budgetModule.syncBudgetServiceFromConfig(configService.getBudgetConfig() as never);
}

describe('Item4① setBudgetConfig → runtime singleton sync', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('pushes the persisted budget into the BudgetService singleton', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-budget-cfgsync-'));
    const { configModule, budgetModule } = await loadModules(dataDir);
    const configService = new configModule.ConfigService();
    await configService.initialize();

    expect(budgetModule.getBudgetService().getConfig().maxBudget).toBe(10.0);

    await applyBudgetUpdate(configService, budgetModule, { maxBudget: 33, warningThreshold: 0.5 });

    const synced = budgetModule.getBudgetService().getConfig();
    expect(synced.maxBudget).toBe(33);
    expect(synced.warningThreshold).toBe(0.5);
    // 持久化与单例一致
    expect(configService.getBudgetConfig().maxBudget).toBe(33);
  });

  it('syncBudgetServiceFromConfig merges partial config onto the singleton', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-budget-cfgsync2-'));
    const { budgetModule } = await loadModules(dataDir);
    budgetModule.getBudgetService().updateConfig({ maxBudget: 99, enabled: true });

    budgetModule.syncBudgetServiceFromConfig({ enabled: false });

    const cfg = budgetModule.getBudgetService().getConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxBudget).toBe(99); // 未覆盖字段保留
  });
});
