import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      getPath: (name: string) => {
        if (name === 'userData' || name === 'home') return dataDir;
        return dataDir;
      },
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

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-config-test-'));
}

describe('ConfigService local provider defaults', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('enables the local provider for fresh settings', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(service.getSettings().models.providers.local?.enabled).toBe(true);
    const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as AppSettings;
    expect(saved.models.providers.local?.enabled).toBe(true);
  });

  it('migrates old untouched local:false settings to enabled', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      models: {
        providers: {
          local: { enabled: false },
        },
      },
    }));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(service.getSettings().models.providers.local?.enabled).toBe(true);
    const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8')) as AppSettings;
    expect(saved.models.providers.local?.enabled).toBe(true);
  });

  it('does not override customized disabled local provider settings', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      models: {
        providers: {
          local: {
            enabled: false,
            updatedAt: 1,
            models: {
              'llama3.2': { enabled: false },
            },
          },
        },
      },
    }));
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(service.getSettings().models.providers.local?.enabled).toBe(false);
  });
});
