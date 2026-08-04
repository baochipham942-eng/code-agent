import { mkdtemp, writeFile } from 'fs/promises';
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
      getPath: () => dataDir,
    },
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

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-voice-live-default-'));
}

describe('ConfigService realtime voice default', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('enables realtime voice for a fresh data directory', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(service.getSettings().voice?.live?.enabled).toBe(true);
  });

  it('preserves an explicitly disabled existing setting', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      voice: { live: { enabled: false } },
    }));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(service.getSettings().voice?.live?.enabled).toBe(false);
  });
});
