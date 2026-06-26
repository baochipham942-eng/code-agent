import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

async function loadModulesForDataDir(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockClear();
  secureStorageMock.saveSettingsToKeychain.mockClear();

  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: (_name: string) => dataDir,
    },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/host/services/infra/logger', () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }));
  vi.doMock('../../../../src/host/permissions/policyEngine', () => ({
    getPolicyEngine: () => ({ loadUserRules: vi.fn() }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides: vi.fn(),
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides: vi.fn(),
  }));

  return {
    configModule: await import('../../../../src/host/services/core/configService'),
    budgetModule: await import('../../../../src/host/services/core/budgetService'),
  };
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-budget-init-'));
}

// 验证启动接线：initBudgetService(configService.getBudgetConfig()) 必须让运行时单例
// 采用持久化的预算配置，而不是构造函数硬编码的 $10/24h 默认值。
// （这正是 initCoreServices 启动期所做的事，此处对其核心逻辑做单元覆盖。）
describe('Budget startup wiring — initBudgetService(getBudgetConfig())', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('initializes the singleton from persisted budget config (not hardcoded defaults)', async () => {
    const dataDir = await createDataDir();
    // 模拟用户已在 config.json 里设过非默认预算
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({ budget: { enabled: true, maxBudget: 30, warningThreshold: 0.6 } }),
    );

    const { configModule, budgetModule } = await loadModulesForDataDir(dataDir);
    const configService = new configModule.ConfigService();
    await configService.initialize();

    // 启动接线
    budgetModule.initBudgetService(configService.getBudgetConfig());

    const synced = budgetModule.getBudgetService().getConfig();
    expect(synced.maxBudget).toBe(30);
    expect(synced.warningThreshold).toBe(0.6);
    // 未设字段沿用持久化默认
    expect(synced.blockThreshold).toBe(1.0);
  });

  it('initBudgetService on an existing singleton updates rather than replaces config', async () => {
    const dataDir = await createDataDir();
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({ budget: { maxBudget: 7 } }),
    );

    const { configModule, budgetModule } = await loadModulesForDataDir(dataDir);
    const configService = new configModule.ConfigService();
    await configService.initialize();

    // 先有一个默认单例（模拟 getBudgetService 在 init 前被某处提前触发）
    expect(budgetModule.getBudgetService().getConfig().maxBudget).toBe(10.0);

    budgetModule.initBudgetService(configService.getBudgetConfig());

    expect(budgetModule.getBudgetService().getConfig().maxBudget).toBe(7);
  });
});
