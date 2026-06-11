// ============================================================================
// reconcileManagedProviders：团队共享 provider（中转站）本地 reconcile 测试
// ============================================================================

import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/shared/contract';
import type {
  SharedProviderConfig,
  SharedProviderKeyConfig,
  SharedServiceKeyConfig,
} from '../../../../src/main/services/cloud/builtinConfig';

const keyStore = new Map<string, string>();
const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  get: vi.fn((key: string) => keyStore.get(key)),
  set: vi.fn((key: string, value: string) => { keyStore.set(key, value); }),
  delete: vi.fn((key: string) => { keyStore.delete(key); }),
  getApiKey: vi.fn((provider: string) => keyStore.get(provider)),
  setApiKey: vi.fn((provider: string, key: string) => { keyStore.set(provider, key); }),
  deleteApiKey: vi.fn((provider: string) => { keyStore.delete(provider); }),
  getStoredApiKeyProviders: vi.fn(() => Array.from(keyStore.keys())),
};

async function loadConfigService(dataDir: string) {
  vi.resetModules();
  vi.doMock('../../../../src/main/platform', () => ({
    app: {
      isPackaged: false,
      getPath: () => dataDir,
    },
  }));
  vi.doMock('../../../../src/main/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/main/services/infra/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));
  vi.doMock('../../../../src/main/permissions/policyEngine', () => ({
    getPolicyEngine: () => ({ loadUserRules: vi.fn() }),
  }));
  vi.doMock('../../../../src/main/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides: vi.fn(),
  }));
  vi.doMock('../../../../src/main/model/providers/shared', () => ({
    setProviderProxyOverrides: vi.fn(),
  }));
  return import('../../../../src/main/services/core/configService');
}

const relayProvider: SharedProviderConfig = {
  id: 'custom-team-relay',
  displayName: '团队共享',
  baseUrl: 'https://tokenflux.dev/v1',
  apiKey: 'sk-relay-secret',
  protocol: 'openai',
  billingMode: 'unknown',
  models: [{ id: 'gpt-5.3' }, { id: 'gpt-5.4', label: 'GPT-5.4' }],
};

const tavilyKey: SharedServiceKeyConfig = {
  service: 'tavily',
  displayName: '团队 Tavily',
  apiKey: 'tvly-team-secret',
  requiredCapability: 'shared_search',
};

const openaiRelayKey: SharedServiceKeyConfig = {
  service: 'openai',
  displayName: '团队 OpenAI 搜索',
  apiKey: 'sk-openai-relay-secret',
  baseUrl: 'https://free.example/v1/',
  requiredCapability: 'shared_search',
};

describe('ConfigService.reconcileManagedProviders', () => {
  afterEach(() => {
    keyStore.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('upsert：注入托管 custom provider，key 进 SecureStorage 不落明文 settings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviders([relayProvider]);

    const providers = service.getSettings().models.providers as Record<string, Record<string, unknown>>;
    const injected = providers['custom-team-relay'];
    expect(injected).toBeTruthy();
    expect(injected.enabled).toBe(true);
    expect(injected.managedByCloud).toBe(true);
    expect(injected.baseUrl).toBe('https://tokenflux.dev/v1');
    expect(injected.displayName).toBe('团队共享');
    expect((injected.models as Record<string, unknown>)['gpt-5.3']).toEqual({ enabled: true });
    expect((injected.models as Record<string, unknown>)['gpt-5.4']).toEqual({ enabled: true, label: 'GPT-5.4' });

    // key 进 SecureStorage
    expect(secureStorageMock.setApiKey).toHaveBeenCalledWith('custom-team-relay', 'sk-relay-secret');
    expect(keyStore.get('custom-team-relay')).toBe('sk-relay-secret');

    // 持久化文件里不得出现明文 key
    const saved = await readFile(join(dataDir, 'config.json'), 'utf-8');
    expect(saved).not.toContain('sk-relay-secret');
    const savedJson = JSON.parse(saved) as AppSettings;
    expect((savedJson.models.providers['custom-team-relay'] as { managedByCloud?: boolean })?.managedByCloud).toBe(true);
  });

  it('停发：之前托管、本次不再下发的被移除，key 被删', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviders([relayProvider]);
    expect(service.getSettings().models.providers['custom-team-relay']).toBeTruthy();

    // 管理员关闭 → 控制面停发 → 传 []
    await service.reconcileManagedProviders([]);

    expect(service.getSettings().models.providers['custom-team-relay']).toBeUndefined();
    expect(secureStorageMock.deleteApiKey).toHaveBeenCalledWith('custom-team-relay');
    expect(keyStore.has('custom-team-relay')).toBe(false);
  });

  it('不误删用户自建的非托管 custom provider', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    // 用户手动加的 custom provider（无 managedByCloud）
    await service.updateSettings({
      models: {
        providers: {
          'custom-my-own': { enabled: true, baseUrl: 'https://my.relay/v1' },
        },
      },
    } as unknown as Partial<AppSettings>);

    await service.reconcileManagedProviders([relayProvider]);
    await service.reconcileManagedProviders([]); // 托管的全停发

    // 用户自建的应当还在
    expect(service.getSettings().models.providers['custom-my-own']).toBeTruthy();
    expect(service.getSettings().models.providers['custom-team-relay']).toBeUndefined();
  });

  it('无可用默认模型时：把共享 provider 首个模型设为激活默认（零配置可聊）', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviders([relayProvider]);

    const s = service.getSettings();
    expect(s.models.default).toBe('custom-team-relay');
    expect(s.models.defaultProvider).toBe('custom-team-relay');
    expect(s.models.providers['custom-team-relay']?.model).toBe('gpt-5.3');
  });

  it('已有可用默认（已配自己的 key）时：不抢默认', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    // 给当前默认 provider 配上 key → 可用
    const currentDefault = service.getSettings().models.default;
    keyStore.set(currentDefault, 'my-own-existing-key');

    await service.reconcileManagedProviders([relayProvider]);

    // 默认不被共享 provider 抢走
    expect(service.getSettings().models.default).toBe(currentDefault);
  });
});

describe('ConfigService.reconcileManagedServiceApiKeys', () => {
  afterEach(() => {
    keyStore.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('upsert：注入托管搜索服务 key，getServiceApiKey 可直接读到', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-service-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedServiceApiKeys([tavilyKey]);

    expect(secureStorageMock.setApiKey).toHaveBeenCalledWith('cloud-service-key:tavily', 'tvly-team-secret');
    expect(service.getServiceApiKey('tavily')).toBe('tvly-team-secret');

    const saved = await readFile(join(dataDir, 'config.json'), 'utf-8');
    expect(saved).not.toContain('tvly-team-secret');
  });

  it('upsert：注入托管 OpenAI-compatible baseUrl，搜索源可读取到规范化端点', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-service-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedServiceApiKeys([openaiRelayKey]);

    expect(secureStorageMock.setApiKey).toHaveBeenCalledWith('cloud-service-key:openai', 'sk-openai-relay-secret');
    expect(secureStorageMock.set).toHaveBeenCalledWith('serviceBaseUrl.cloud.openai', 'https://free.example/v1');
    expect(service.getServiceApiKey('openai')).toBe('sk-openai-relay-secret');
    expect(service.getServiceApiBaseUrl('openai')).toBe('https://free.example/v1');
  });

  it('本地用户 key 优先，不被云端服务 key 覆盖', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-service-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    keyStore.set('tavily', 'tvly-user-secret');
    await service.reconcileManagedServiceApiKeys([tavilyKey]);

    expect(service.getServiceApiKey('tavily')).toBe('tvly-user-secret');
    expect(keyStore.get('cloud-service-key:tavily')).toBe('tvly-team-secret');
  });

  it('停发：删除托管搜索服务 key，但保留用户自己的 key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-service-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    keyStore.set('tavily', 'tvly-user-secret');
    await service.reconcileManagedServiceApiKeys([tavilyKey]);
    await service.reconcileManagedServiceApiKeys([]);

    expect(secureStorageMock.deleteApiKey).toHaveBeenCalledWith('cloud-service-key:tavily');
    expect(keyStore.get('tavily')).toBe('tvly-user-secret');
    expect(keyStore.has('cloud-service-key:tavily')).toBe(false);
  });

  it('停发：删除托管 OpenAI-compatible baseUrl', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-service-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedServiceApiKeys([openaiRelayKey]);
    await service.reconcileManagedServiceApiKeys([]);

    expect(secureStorageMock.deleteApiKey).toHaveBeenCalledWith('cloud-service-key:openai');
    expect(secureStorageMock.delete).toHaveBeenCalledWith('serviceBaseUrl.cloud.openai');
    expect(keyStore.has('cloud-service-key:openai')).toBe(false);
    expect(keyStore.has('serviceBaseUrl.cloud.openai')).toBe(false);
  });
});

describe('ConfigService.reconcileManagedProviderApiKeys', () => {
  const xiaomiManagedKey: SharedProviderKeyConfig = {
    provider: 'xiaomi',
    apiKey: 'sk-mimo-team-secret',
    keyId: 'mimo-key-1',
  };
  let envBackup: string | undefined;

  beforeEach(() => {
    // 模拟全新机器：开发机 env 里的 XIAOMI_API_KEY 会干扰兜底链断言
    envBackup = process.env.XIAOMI_API_KEY;
    delete process.env.XIAOMI_API_KEY;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.XIAOMI_API_KEY;
    else process.env.XIAOMI_API_KEY = envBackup;
    keyStore.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('upsert：托管 key 进 SecureStorage 独立前缀，getApiKey 兜底可读，UI 标记已配置', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-pk-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviderApiKeys([xiaomiManagedKey]);

    expect(secureStorageMock.setApiKey).toHaveBeenCalledWith('cloud-provider-key:xiaomi', 'sk-mimo-team-secret');
    // 模型主链路：modelRouter 经 getApiKey 注入 → 托管 key 兜底生效
    expect(service.getApiKey('xiaomi')).toBe('sk-mimo-team-secret');
    // UI 就绪：getSettings 注入 apiKeyConfigured → 模型设置/切换面板显示已可用
    expect(service.getSettings().models.providers.xiaomi?.apiKeyConfigured).toBe(true);

    // 持久化文件里不得出现明文 key
    const saved = await readFile(join(dataDir, 'config.json'), 'utf-8');
    expect(saved).not.toContain('sk-mimo-team-secret');
  });

  it('用户自配 key 优先于托管 key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-pk-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    keyStore.set('xiaomi', 'sk-my-own-mimo');
    await service.reconcileManagedProviderApiKeys([xiaomiManagedKey]);

    expect(service.getApiKey('xiaomi')).toBe('sk-my-own-mimo');
    expect(keyStore.get('cloud-provider-key:xiaomi')).toBe('sk-mimo-team-secret');
  });

  it('停发吊销：托管 key 被删，用户自己的 key 保留', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-pk-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviderApiKeys([xiaomiManagedKey]);
    expect(service.getApiKey('xiaomi')).toBe('sk-mimo-team-secret');

    await service.reconcileManagedProviderApiKeys([]);

    expect(secureStorageMock.deleteApiKey).toHaveBeenCalledWith('cloud-provider-key:xiaomi');
    expect(keyStore.has('cloud-provider-key:xiaomi')).toBe(false);
    expect(service.getApiKey('xiaomi')).toBeUndefined();
  });

  it('白名单外 provider 的托管 key 不接受', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cfg-shared-pk-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const service = new ConfigService();
    await service.initialize();

    await service.reconcileManagedProviderApiKeys([
      { provider: 'custom-evil', apiKey: 'sk-evil' },
      { provider: 'openai', apiKey: 'sk-not-whitelisted' },
    ]);

    expect(keyStore.has('cloud-provider-key:custom-evil')).toBe(false);
    expect(keyStore.has('cloud-provider-key:openai')).toBe(false);
    expect(secureStorageMock.setApiKey).not.toHaveBeenCalled();
  });
});
