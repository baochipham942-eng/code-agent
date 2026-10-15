import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/shared/contract';

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null as Record<string, unknown> | null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockReset();
  secureStorageMock.getSettingsFromKeychain.mockResolvedValue(null);
  secureStorageMock.saveSettingsToKeychain.mockReset();
  secureStorageMock.saveSettingsToKeychain.mockResolvedValue(undefined);

  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: (name: string) => (name === 'userData' || name === 'home' ? dataDir : dataDir),
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

  return import('../../../../src/host/services/core/configService');
}

describe('ConfigService disclosureLevel save/load', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it.each(['simple', 'standard', 'advanced', 'expert'] as const)(
    're-reads persisted %s after restart',
    async (level) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-'));
      const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
      const service = new ConfigService();
      await service.initialize();
      await service.updateSettings({ ui: { disclosureLevel: level } } as Partial<AppSettings>);

      const { ConfigService: Restarted } = await loadConfigServiceForDataDir(dataDir);
      const restarted = new Restarted();
      await restarted.initialize();

      expect(restarted.getSettings().ui.disclosureLevel).toBe(level);
    },
  );

  it('loads an old settings file that still contains a removed ui flag', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-old-'));
    const configPath = join(dataDir, 'config.json');
    const removedFlag = 'show' + 'ToolCalls';
    await writeFile(configPath, JSON.stringify({
      ui: { [removedFlag]: true, disclosureLevel: 'advanced' },
    }));

    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await expect(service.initialize()).resolves.toBeUndefined();

    const ui = service.getSettings().ui as Record<string, unknown>;
    expect(ui.disclosureLevel).toBe('advanced');
    expect(ui[removedFlag]).toBe(true);
  });

  it('persists simple for a fresh data dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-fresh-'));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('simple');
    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as {
      ui: { disclosureLevel?: string };
    };
    expect(onDisk.ui.disclosureLevel).toBe('simple');
  });

  it('keeps an existing standard level', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-standard-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      ui: { theme: 'dark', disclosureLevel: 'standard' },
    }));

    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('standard');
    expect(service.getSettings().ui.theme).toBe('dark');
    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as {
      ui: { disclosureLevel?: string };
    };
    expect(onDisk.ui.disclosureLevel).toBe('standard');
  });

  it('keeps standard when an existing config has no disclosureLevel', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-missing-'));
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      ui: { theme: 'dark' },
    }));

    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('standard');
    expect(service.getSettings().ui.theme).toBe('dark');
    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as {
      ui: { disclosureLevel?: string; theme?: string };
    };
    expect(onDisk.ui.disclosureLevel).toBe('standard');
    expect(onDisk.ui.theme).toBe('dark');
  });

  it('restores standard from the keychain onto a fresh data dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-keychain-standard-'));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    secureStorageMock.getSettingsFromKeychain.mockResolvedValue({
      disclosureLevel: 'standard',
    });
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('standard');
    const onDisk = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as {
      ui: { disclosureLevel?: string };
    };
    expect(onDisk.ui.disclosureLevel).toBe('standard');
  });

  it('falls back to standard when the persisted level is invalid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-bad-'));
    const configPath = join(dataDir, 'config.json');
    const removedFlag = 'show' + 'ToolCalls';
    await writeFile(configPath, JSON.stringify({
      ui: { [removedFlag]: false, disclosureLevel: 'not-a-level' },
    }));

    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.getSettings().ui.disclosureLevel).toBe('standard');

    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      ui: Record<string, unknown>;
    };
    expect(onDisk.ui.disclosureLevel).toBe('standard');
    expect(onDisk.ui[removedFlag]).toBe(false);
  });

  it('ignores an unknown keychain flag and an invalid level', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'code-agent-disclosure-keychain-'));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const removedFlag = 'show' + 'ToolCalls';
    secureStorageMock.getSettingsFromKeychain.mockResolvedValue({
      [removedFlag]: true,
      disclosureLevel: 'not-a-level',
    });
    const service = new ConfigService();
    await expect(service.initialize()).resolves.toBeUndefined();
    // 全新目录上非法钥匙串值等于没有值，留下出厂默认 simple。
    expect(service.getSettings().ui.disclosureLevel).toBe('simple');
    expect(service.getSettings().ui).not.toHaveProperty(removedFlag);
  });
});
