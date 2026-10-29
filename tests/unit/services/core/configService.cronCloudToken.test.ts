// ============================================================================
// 云端计划任务令牌的落点（N-CRON-WEBHOOK-CLOUD-HOOK-FU1 ④）：
// 设置页保存 = settings.cronCloud.baseUrl（config.json）+ setServiceApiKey('neo-cron-cloud')
// （secureStorage）。令牌绝不出现在 config.json；读取走 getServiceApiKey。
// ============================================================================
import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLOUD_TOKEN = 'cloud-token-d41d8cd9-secret';
const stored = new Map<string, string>();
const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn((key: string) => stored.get(key)),
  setApiKey: vi.fn((key: string, value: string) => { stored.set(key, value); }),
  getStoredApiKeyProviders: vi.fn(() => []),
  get: vi.fn(() => undefined),
};

async function loadConfigService(dataDir: string) {
  vi.resetModules();
  vi.doMock('../../../../src/host/platform', () => ({
    app: { isPackaged: false, getPath: (_name: string) => dataDir },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/host/services/infra/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));
  return import('../../../../src/host/services/core/configService');
}

describe('neo-cron-cloud 令牌只进 secureStorage', () => {
  afterEach(() => {
    stored.clear();
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.resetModules();
  });

  it('保存后 config.json 只有地址；令牌在 secureStorage，getServiceApiKey 读得回', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-config-cron-cloud-'));
    const { ConfigService } = await loadConfigService(dataDir);
    const config = new ConfigService();
    await config.initialize();

    await config.updateSettings({ cronCloud: { baseUrl: 'https://cloud.example.test' } });
    await config.setServiceApiKey('neo-cron-cloud', CLOUD_TOKEN);

    const onDisk = await readFile(join(dataDir, 'config.json'), 'utf8');
    expect(JSON.parse(onDisk).cronCloud).toEqual({ baseUrl: 'https://cloud.example.test' });
    expect(onDisk).not.toContain(CLOUD_TOKEN);
    expect(secureStorageMock.setApiKey).toHaveBeenCalledWith('neo-cron-cloud', CLOUD_TOKEN);
    expect(config.getServiceApiKey('neo-cron-cloud')).toBe(CLOUD_TOKEN);
  });
});
