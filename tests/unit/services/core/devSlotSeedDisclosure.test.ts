import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// N-DISCLOSURE-DEFAULT-SIMPLE-FRESH：seed → 真 ConfigService.initialize 集成。
// (i) seed 过的 dev 槽首启 = simple（FB-483 修复面）；
// (ii) 既有无该字段的非 seed config 仍钉 standard（升级规则不动）。

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null as Record<string, unknown> | null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => [] as string[]),
};

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: (name: string) => (name === 'userData' || name === 'home' ? dataDir : dataDir),
    },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
    readModelCredentialsFromDataDir: () => ({} as Record<string, string>),
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

describe('devSlotSeed → ConfigService.initialize integration (FB-483)', () => {
  const originalHome = process.env.CODE_AGENT_HOME;
  let root: string;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = originalHome;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('seeded dev slot initializes to simple and stays simple on disk', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb483-seeded-'));
    process.env.CODE_AGENT_HOME = root;
    const prod = path.join(root, '.code-agent');
    fs.mkdirSync(prod, { recursive: true });
    fs.writeFileSync(path.join(prod, 'config.json'), JSON.stringify({
      models: { default: 'x', providers: { p1: { enabled: true } } },
      ui: { disclosureLevel: 'expert' }, // 生产槽的级别绝不能跨槽带过来
    }));
    const { seedDevSlotFromProduction } = await import('../../../../src/host/services/core/devSlotSeed');
    const devDir = path.join(root, '.code-agent-dev9');
    expect(seedDevSlotFromProduction(devDir).seeded).toBe(true);

    // seed 写出的原始文件只有 models+ui（无 permissions/execPolicy 跨槽）——
    // 在 initialize 重写盘文件之前断言。
    const seededFile = JSON.parse(fs.readFileSync(path.join(devDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(seededFile).sort()).toEqual(['models', 'ui']);
    expect(seededFile.permissions).toBeUndefined();
    expect(seededFile.execPolicy).toBeUndefined();

    const { ConfigService } = await loadConfigServiceForDataDir(devDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('simple');
    const onDisk = JSON.parse(fs.readFileSync(path.join(devDir, 'config.json'), 'utf-8')) as {
      ui: { disclosureLevel: string };
    };
    expect(onDisk.ui.disclosureLevel).toBe('simple');
  });

  it('existing non-seeded config without the field still pins standard', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb483-existing-'));
    const dir = path.join(root, 'legacy-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ models: { default: 'x' } }));

    const { ConfigService } = await loadConfigServiceForDataDir(dir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().ui.disclosureLevel).toBe('standard');
  });
});
