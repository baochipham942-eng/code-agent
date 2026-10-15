// ============================================================================
// settings.jev 持久化（N-JEV-DEFAULT-ON-CONSENT ②）—— Jev 总开关与 OpenRouter 借用
// 同意经 configService.updateSettings 落进 config.json，由**全新实例**读回（重启口径）；
// 写路径的时间戳语义（首次同意记录、缺省才回落 Date.now()）也在 updateSettings。
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

  it('首次同意记录时间戳（缺省回落 Date.now()），重复同意不刷新，撤销不删除', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const writer = new ConfigService();
    await writer.initialize();

    // 首次同意、未带时间戳：回落 Date.now()（夹在调用前后之间）。
    const before = Date.now();
    await writer.updateSettings({ jev: { openRouterConsent: true } });
    const first = writer.getSettings().jev ?? {};
    expect(first.openRouterConsent).toBe(true);
    expect(first.openRouterConsentAt).toBeGreaterThanOrEqual(before);
    expect(first.openRouterConsentAt).toBeLessThanOrEqual(Date.now());
    const firstAt = first.openRouterConsentAt as number;

    // 已同意状态再次同意：时间戳保持首次值（保留原始时间，不被 Date.now() 冲掉）。
    await writer.updateSettings({ jev: { openRouterConsent: true } });
    expect(writer.getSettings().jev?.openRouterConsentAt).toBe(firstAt);

    // 撤销：consent=false，时间戳留作历史。
    await writer.updateSettings({ jev: { openRouterConsent: false } });
    expect(writer.getSettings().jev).toEqual({
      enabled: true,
      openRouterConsent: false,
      openRouterConsentAt: firstAt,
    });
  });

  it('调用方显式时间戳原样写入（首次同意），不回落 Date.now()', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const writer = new ConfigService();
    await writer.initialize();

    await writer.updateSettings({ jev: { openRouterConsent: true, openRouterConsentAt: 1_700_000_000_000 } });
    expect(writer.getSettings().jev?.openRouterConsentAt).toBe(1_700_000_000_000);
  });

  it('patch 不含 jev 块时不触碰 jev 设置（无关键忽略）', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const writer = new ConfigService();
    await writer.initialize();

    await writer.updateSettings({ jev: { openRouterConsent: true, openRouterConsentAt: 111 } });
    await writer.updateSettings({ daemon: { launchAtLogin: true } });
    expect(writer.getSettings().jev).toEqual({
      enabled: true,
      openRouterConsent: true,
      openRouterConsentAt: 111,
    });
    expect(writer.getSettings().daemon.launchAtLogin).toBe(true);
  });
});
