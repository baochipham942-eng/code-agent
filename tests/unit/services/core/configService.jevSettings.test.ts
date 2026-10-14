// ============================================================================
// settings.jev 持久化（N-JEV-DEFAULT-ON-CONSENT ②）—— Jev 总开关与 OpenRouter 借用
// 同意经 configService.updateSettings 落进 config.json，由**全新实例**读回（重启口径）；
// 写路径的时间戳语义（首次同意记录、缺省才回落 Date.now()）在 settings.ipc 的
// handleSetJevSettings，见 tests/unit/ipc/settings.domain.ipc.test.ts。
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
  return mkdtemp(join(tmpdir(), 'code-agent-config-jev-'));
}

describe('settings.jev 持久化（重启读回）', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.resetModules();
  });

  it('缺省开/未同意；写入后全新实例读回一致；老配置无 jev 块按缺省处理', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const writer = new ConfigService();
    await writer.initialize();

    // 老配置（无 jev 块）升级口径：总开关开、未同意；缺省会随 initialize 落盘。
    expect(writer.getSettings().jev).toMatchObject({ enabled: true, openRouterConsent: false });
    const onDiskBefore = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    expect(onDiskBefore.jev).toEqual({ enabled: true, openRouterConsent: false });

    await writer.updateSettings({
      jev: { enabled: false, openRouterConsent: true, openRouterConsentAt: 1_767_225_600_000 },
    });

    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    expect(onDisk.jev).toEqual({
      enabled: false,
      openRouterConsent: true,
      openRouterConsentAt: 1_767_225_600_000,
    });

    // 全新实例（重启口径）读回：关闭保持关闭、同意与时间戳保持。
    const { ConfigService: FreshConfigService } = await loadConfigServiceForDataDir(dataDir);
    const fresh = new FreshConfigService();
    await fresh.initialize();
    expect(fresh.getSettings().jev).toEqual({
      enabled: false,
      openRouterConsent: true,
      openRouterConsentAt: 1_767_225_600_000,
    });
  });
});
