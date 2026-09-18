// ============================================================================
// N-MODELCAT-LONGCAT-PREVIEW-RETIRE — LongCat-2.0-Preview 退役钉子
// ①内建目录/registry 不再有 Preview ②兜底与归一化指向 LongCat-2.0
// ③存量配置幂等迁移（只动官方 longcat，第三方自报不动）
// ============================================================================
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_MODELS,
  getContextWindow,
  getModelMaxOutputTokens,
  normalizeModelId,
} from '../../../../src/shared/constants';
import { PROVIDER_REGISTRY } from '../../../../src/host/model/providerRegistry';
import { normalizeLongCatModelId } from '../../../../src/renderer/components/features/settings/tabs/ModelSettings.helpers';
import type { AppSettings } from '../../../../src/shared/contract';

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
  secureStorageMock.getApiKey.mockClear();

  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: () => dataDir,
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
    getPolicyEngine: () => ({
      loadUserRules: vi.fn(),
    }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides: vi.fn(),
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides: vi.fn(),
  }));

  return import('../../../../src/host/services/core/configService');
}

describe('①② 内建目录与归一化已摘 LongCat-2.0-Preview', () => {
  it('① catalog 与 registry 的 longcat 只剩 LongCat-2.0', () => {
    const catalogLongcat = PROVIDER_MODELS.find((provider) => provider.id === 'longcat');
    expect(catalogLongcat?.models.map((model) => model.id)).toEqual(['LongCat-2.0']);

    expect(PROVIDER_REGISTRY.longcat.models.map((model) => model.id)).toEqual(['LongCat-2.0']);
    // Preview 的 thinking 开关由 GA 名继承，迁移过去的用户不丢控制
    expect(PROVIDER_REGISTRY.longcat.models[0]?.thinking).toEqual({ kind: 'toggle', defaultEnabled: true });
  });

  it('② 兜底/归一化返回 LongCat-2.0，存量 Preview 查表经迁移映射仍命中', () => {
    expect(normalizeLongCatModelId('longcat-2.0-preview')).toBe('LongCat-2.0');
    expect(normalizeLongCatModelId(undefined)).toBe('LongCat-2.0');
    expect(normalizeModelId('LongCat-2.0-Preview')).toBe('LongCat-2.0');
    // 摘表后老值靠 MODEL_MIGRATIONS 归一命中，不落 128k/16k 兜底
    expect(getContextWindow('LongCat-2.0-Preview')).toBe(131_072);
    expect(getModelMaxOutputTokens('LongCat-2.0-Preview')).toBe(32_768);
  });
});

describe('③ LongCat-2.0-Preview 存量配置迁移', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  const retiredFixture = () => ({
    models: {
      default: 'longcat',
      providers: {
        longcat: {
          enabled: true,
          model: 'LongCat-2.0-Preview',
          models: {
            'LongCat-2.0-Preview': {
              enabled: true,
              label: 'LongCat 2.0 Preview',
              thinking: { enabled: false },
            },
          },
        },
        // 第三方中转自报同名模型：它们自己的事，迁移不得碰
        'custom-commonstack-longcat': {
          enabled: true,
          model: 'LongCat-2.0-Preview',
          models: {
            'LongCat-2.0-Preview': { enabled: true, label: 'LongCat 2.0 Preview' },
          },
        },
      },
      routing: {
        code: { provider: 'longcat', model: 'LongCat-2.0-Preview' },
        fast: { provider: 'longcat', model: 'LongCat-2.0' },
        vision: { provider: 'xiaomi', model: 'mimo-v2-omni' },
        memory: { provider: 'longcat', model: 'LongCat-2.0-Preview' },
        gui: { provider: 'custom-commonstack-longcat', model: 'LongCat-2.0-Preview' },
      },
      taskStrategy: {
        mode: 'manual',
        defaultProfile: 'main',
        profiles: {
          fast: { provider: 'zhipu', model: 'glm-4-flash', reasoningEffort: 'low', maxTokens: 4096 },
          main: { provider: 'longcat', model: 'LongCat-2.0-Preview', reasoningEffort: 'medium', maxTokens: 16384 },
          deep: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 32768 },
          vision: { provider: 'xiaomi', model: 'mimo-v2-omni', reasoningEffort: 'medium', maxTokens: 4096 },
        },
        fallback: { enabled: true, preferSameProvider: true, allowCrossProvider: true },
        rules: [],
      },
    },
  });

  it('providers.longcat / routing 各档 / taskStrategy.profiles 迁到 LongCat-2.0，第三方原样', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-longcat-retire-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(retiredFixture()));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    const settings = service.getSettings();

    // 默认模型档位迁移；models map 改 key、丢旧名 label、保用户 thinking 档
    expect(settings.models.providers.longcat.model).toBe('LongCat-2.0');
    expect(settings.models.providers.longcat.models).toEqual({
      'LongCat-2.0': { enabled: true, thinking: { enabled: false } },
    });

    expect(settings.models.routing.code).toEqual({ provider: 'longcat', model: 'LongCat-2.0' });
    expect(settings.models.routing.memory).toEqual({ provider: 'longcat', model: 'LongCat-2.0' });
    expect(settings.models.routing.gui).toEqual({ provider: 'custom-commonstack-longcat', model: 'LongCat-2.0-Preview' });
    expect(settings.models.taskStrategy?.profiles.main).toMatchObject({ provider: 'longcat', model: 'LongCat-2.0' });

    // 第三方 provider 的 model 与 models map 一字不动（apiKeyConfigured 是 getSettings 的展示期注入，不算改动）
    expect(settings.models.providers['custom-commonstack-longcat']).toMatchObject({
      enabled: true,
      model: 'LongCat-2.0-Preview',
      models: {
        'LongCat-2.0-Preview': { enabled: true, label: 'LongCat 2.0 Preview' },
      },
    });
  });

  it('幂等：第二遍 initialize 不再改动任何字段', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-longcat-retire-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(retiredFixture()));

    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const first = new ConfigService();
    await first.initialize();
    const firstSettings: AppSettings = JSON.parse(JSON.stringify(first.getSettings()));
    const firstFile = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as AppSettings;

    // 模拟下一次启动：重新加载已迁移的配置
    const second = new ConfigService();
    await second.initialize();
    expect(JSON.parse(JSON.stringify(second.getSettings()))).toEqual(firstSettings);
    // 落盘的 models 相关字段同样不再变化（permissions._legacyPermissions 是
    // 既有 DEFAULT_SETTINGS 共享引用怪癖，与本迁移无关，不纳入比对）
    const secondFile = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as AppSettings;
    expect(secondFile.models.providers.longcat).toEqual(firstFile.models.providers.longcat);
    expect(secondFile.models.routing).toEqual(firstFile.models.routing);
    expect(secondFile.models.taskStrategy?.profiles).toEqual(firstFile.models.taskStrategy?.profiles);
    // 第三方 provider 的 Preview 持久化层也原样保留
    expect(secondFile.models.providers['custom-commonstack-longcat']?.model).toBe('LongCat-2.0-Preview');
  });

  it('legacy custom LongCat 迁移目标也指向 GA 名（含空 model 兜底）', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-longcat-retire-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      models: {
        default: 'custom',
        providers: {
          custom: {
            enabled: true,
            displayName: 'LongCat',
            baseUrl: 'https://api.longcat.chat/openai/v1',
          },
        },
        routing: {
          code: { provider: 'custom', model: 'longcat-2.0-preview' },
          fast: { provider: 'custom', model: 'longcat-2.0-preview' },
          vision: { provider: 'xiaomi', model: 'mimo-v2-omni' },
          gui: { provider: 'zhipu', model: 'glm-4.6v-flash' },
        },
      },
    }));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    const settings = service.getSettings();
    expect(settings.models.default).toBe('longcat');
    // legacy.model 为空 → 兜底 LongCat-2.0；routing 从 custom 迁来并归一到 GA 名
    expect(settings.models.providers.longcat.model).toBe('LongCat-2.0');
    expect(settings.models.providers.longcat.models?.['LongCat-2.0']).toMatchObject({
      enabled: true,
      label: 'LongCat 2.0',
    });
    expect(settings.models.routing.code).toEqual({ provider: 'longcat', model: 'LongCat-2.0' });
    expect(settings.models.routing.fast).toEqual({ provider: 'longcat', model: 'LongCat-2.0' });
    // custom 槽位退役、不残留 Preview
    expect(settings.models.providers.longcat.models?.['LongCat-2.0-Preview']).toBeUndefined();
  });
});
