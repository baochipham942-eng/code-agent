// ============================================================================
// N-QUICK-0KI-FLASH — quick 档旧默认退役钉子
// 存量持久化 models.routing.fast 指向旧默认 zhipu/glm-4-flash（免费档官方 key 已死）
// 时迁移到 DEFAULT_MODELS.quick（只动 routing.fast，它没有 UI 入口）；
// taskStrategy.profiles.fast、providers.zhipu.model、models map、其它档位里的同名值视为用户显式选择，一字不动。
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

  // providers.zhipu.model / models map / routing.code 都填旧默认同名值：这些位置只能来自用户显式选择，
  // glm-4-flash 仍在 catalog 可选，迁移不许碰。
  const fixtureWithFast = (fast: { provider: string; model: string }) => ({
    models: {
      default: 'longcat',
      providers: {
        longcat: { enabled: true, model: 'LongCat-2.0' },
        zhipu: { enabled: true, model: 'glm-4-flash', models: { 'glm-4-flash': { label: '用户自定义' } } },
      },
      routing: {
        code: { provider: 'zhipu', model: 'glm-4-flash' },
        fast,
        vision: { provider: 'xiaomi', model: 'mimo-v2-omni' },
      },
      taskStrategy: {
        profiles: {
          fast,
          main: { provider: 'zhipu', model: 'glm-4-flash' },
        },
      },
    },
  });

  const expectUserChoicesUntouched = (models: Record<string, any>) => {
    expect(models.providers.zhipu.model).toBe('glm-4-flash');
    expect(models.providers.zhipu.models).toMatchObject({ 'glm-4-flash': { label: '用户自定义' } });
    expect(models.routing.code).toMatchObject({ provider: 'zhipu', model: 'glm-4-flash' });
    expect(models.taskStrategy.profiles.main).toMatchObject({ provider: 'zhipu', model: 'glm-4-flash' });
  };

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
    // profiles.fast 有任务策略面板入口，同名值可能是用户刚选的：不迁
    expect(service.getSettings().models.taskStrategy?.profiles.fast).toMatchObject({ provider: 'zhipu', model: 'glm-4-flash' });
    expectUserChoicesUntouched(service.getSettings().models as Record<string, any>);

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
    expectUserChoicesUntouched(service.getSettings().models as Record<string, any>);
  });
});
