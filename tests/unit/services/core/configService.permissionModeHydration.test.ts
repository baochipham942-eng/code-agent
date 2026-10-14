// ============================================================================
// 启动灌回持久化权限档（N-ARTIFACT-STANDING-REFRESH-REALRUN 真跑发现的缺陷回归）。
// 病灶：PERMISSION_SET_MODE 落盘时承诺「重启/重装后恢复」，但 PermissionModeManager
// 构造默认 default 且无人灌回——重启后新会话（含 cron 无人值守）全部静默回落
// 请求批准，常设刷新的写类工具一路停车挂起。入口 = ConfigService.initialize()
// （webServer / CLI / 桌面共用的公共路径）。
// ============================================================================
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

  const configServiceModule = await import('../../../../src/host/services/core/configService');
  // 与 configService 同一模块注册表取 manager（vi.resetModules 后两者必须同批 import）
  const modesModule = await import('../../../../src/host/permissions/modes');
  return {
    ConfigService: configServiceModule.ConfigService,
    getPermissionModeManager: modesModule.getPermissionModeManager,
  };
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-permmode-test-'));
}

describe('ConfigService 启动灌回持久化权限档', () => {
  afterEach(() => {
    vi.doUnmock('../../../../src/host/platform');
    vi.doUnmock('../../../../src/host/services/core/secureStorage');
    vi.doUnmock('../../../../src/host/services/infra/logger');
    vi.doUnmock('../../../../src/host/permissions/policyEngine');
    vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
    vi.doUnmock('../../../../src/host/model/providers/shared');
    vi.resetModules();
  });

  it('permissions.permissionMode=acceptEdits：initialize 后全局档是 acceptEdits（重启恢复承诺）', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      permissions: { permissionMode: 'acceptEdits' },
    }));
    const { ConfigService, getPermissionModeManager } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    // 修复前：manager 构造默认 default，无人灌回
    expect(getPermissionModeManager().getMode()).toBe('acceptEdits');
    // 新会话按全局档快照建档（modes.initSessionMode 的语义）
    getPermissionModeManager().initSessionMode('session-hydrated');
    expect(getPermissionModeManager().getModeForSession('session-hydrated')).toBe('acceptEdits');
  });

  it('permissions.permissionMode=bypassPermissions：启动不灌（无法证明落盘走过用户审批，fail-safe 留 default）', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      permissions: { permissionMode: 'bypassPermissions' },
    }));
    const { ConfigService, getPermissionModeManager } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(getPermissionModeManager().getMode()).toBe('default');
  });

  it('未配置权限档：行为不变（default）', async () => {
    const dataDir = await createDataDir();
    const { ConfigService, getPermissionModeManager } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();

    await service.initialize();

    expect(getPermissionModeManager().getMode()).toBe('default');
  });
});
