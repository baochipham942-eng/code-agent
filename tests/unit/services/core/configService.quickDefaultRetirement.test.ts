// ============================================================================
// N-QUICK-0KI-FLASH — quick 档旧默认退役钉子
// 存量持久化 models.routing.fast 指向旧默认 zhipu/glm-4-flash（免费档官方 key 已死）
// 时迁移到 DEFAULT_MODELS.quick；用户显式配过的其它模型一字不动。
// ============================================================================
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS } from '../../../../src/shared/constants';

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockClear();
  secureStorageMock.saveSettingsToKeychain.mockClear();

  vi.doMock('../../../../src/host/platform', () => ({
    app: { isPackaged: false, getPath: () => dataDir },
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
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides: vi.fn(),
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides: vi.fn(),
  }));

  return import('../../../../src/host/services/core/configService');
}

describe('quick 旧默认 glm-4-flash 持久化路由迁移', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  const fixtureWithFast = (fast: { provider: string; model: string }) => ({
    models: {
      default: 'longcat',
      providers: {
        longcat: { enabled: true, model: 'LongCat-2.0' },
      },
      routing: {
        code: { provider: 'longcat', model: 'LongCat-2.0' },
        fast,
        vision: { provider: 'xiaomi', model: 'mimo-v2-omni' },
      },
    },
  });

  it('持久化 routing.fast = zhipu/glm-4-flash → 迁到 DEFAULT_MODELS.quick，幂等', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-quick-retire-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(fixtureWithFast({ provider: 'zhipu', model: 'glm-4-flash' })));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().models.routing.fast).toEqual({
      provider: 'zhipu',
      model: DEFAULT_MODELS.quick,
    });

    // 幂等：同一 settings 再跑一遍迁移为空操作
    const second = new ConfigService();
    await second.initialize();
    expect(second.getSettings().models.routing.fast).toEqual({
      provider: 'zhipu',
      model: DEFAULT_MODELS.quick,
    });
  });

  it('用户显式配过的非旧默认 fast（如 deepseek）与其它档位一字不动', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-quick-keep-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(fixtureWithFast({ provider: 'deepseek', model: 'deepseek-chat' })));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().models.routing.fast).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
