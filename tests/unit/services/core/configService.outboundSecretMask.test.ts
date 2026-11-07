// ============================================================================
// settings.privacy.outboundSecretMask 持久化（N-PROMPT-SECRET-MASK ⑥）
// 经 configService.updateSettings 落进 config.json，由全新实例读回（重启口径）；
// 缺省（老配置无此键）= 关。
// ============================================================================
import { mkdtemp, readFile } from 'fs/promises';
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

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
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

  return import('../../../../src/host/services/core/configService');
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-config-obmask-'));
}

describe('settings.privacy.outboundSecretMask 持久化（重启读回）', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.resetModules();
  });

  it('缺省关；写入后落盘且全新实例读回为开', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const writer = new ConfigService();
    await writer.initialize();

    // 老配置（无此键）升级口径：缺省 = 关（undefined，不物化默认值）
    expect(writer.getSettings().privacy?.outboundSecretMask).toBeUndefined();

    await writer.updateSettings({ privacy: { outboundSecretMask: true } });

    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    expect(onDisk.privacy.outboundSecretMask).toBe(true);

    // 全新实例（重启口径）读回
    const { ConfigService: FreshConfigService } = await loadConfigServiceForDataDir(dataDir);
    const fresh = new FreshConfigService();
    await fresh.initialize();
    expect(fresh.getSettings().privacy?.outboundSecretMask).toBe(true);

    // 关掉再读回：显式 false 落盘
    await fresh.updateSettings({ privacy: { outboundSecretMask: false } });
    const onDiskOff = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    expect(onDiskOff.privacy.outboundSecretMask).toBe(false);
    expect(fresh.getSettings().privacy?.outboundSecretMask).toBe(false);
  });
});
