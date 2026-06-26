import { mkdtemp, readFile, writeFile } from 'fs/promises';
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

// 提到顶层以便断言 reload 重跑了注入全局状态的 apply 函数
const loadUserRules = vi.fn();
const setProviderConcurrencyOverrides = vi.fn();
const setProviderProxyOverrides = vi.fn();

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  secureStorageMock.getSettingsFromKeychain.mockClear();
  secureStorageMock.saveSettingsToKeychain.mockClear();
  loadUserRules.mockClear();
  setProviderConcurrencyOverrides.mockClear();
  setProviderProxyOverrides.mockClear();

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
    getPolicyEngine: () => ({ loadUserRules }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides,
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides,
  }));

  return import('../../../../src/host/services/core/configService');
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-config-reload-'));
}

describe('ConfigService.reloadFromDisk', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('picks up external edits into memory and re-runs apply hooks', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().models.default).not.toBe('openai');
    // 模拟外部直接编辑 config.json
    loadUserRules.mockClear();
    setProviderConcurrencyOverrides.mockClear();
    setProviderProxyOverrides.mockClear();
    await writeFile(configPath, JSON.stringify({ models: { default: 'openai' } }));

    const ok = await service.reloadFromDisk();

    expect(ok).toBe(true);
    expect(service.getSettings().models.default).toBe('openai');
    // 三个注入全局状态的 apply 函数都被重新执行
    expect(loadUserRules).toHaveBeenCalledTimes(1);
    expect(setProviderConcurrencyOverrides).toHaveBeenCalledTimes(1);
    expect(setProviderProxyOverrides).toHaveBeenCalledTimes(1);
  });

  it('does not write back to disk (no save/sanitize side effects)', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    // 写一份最小配置,reload 不应把完整默认值回写磁盘
    const minimal = { models: { default: 'openai' } };
    await writeFile(configPath, JSON.stringify(minimal));
    const ok = await service.reloadFromDisk();

    expect(ok).toBe(true);
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(onDisk).toEqual(minimal);
  });

  it('returns false on invalid JSON and leaves memory untouched', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    const before = service.getSettings().models.default;
    await writeFile(configPath, '{ this is not valid json');

    const ok = await service.reloadFromDisk();

    expect(ok).toBe(false);
    expect(service.getSettings().models.default).toBe(before);
  });
});
