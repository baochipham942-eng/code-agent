// ============================================================================
// reconcileManagedProviders：团队共享 provider（中转站）本地 reconcile 测试
// ============================================================================

import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/shared/contract';
import type { SharedProviderConfig } from '../../../../src/main/services/cloud/builtinConfig';

const keyStore = new Map<string, string>();
const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
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
