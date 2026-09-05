// ai-review PR #1650 Important① / ②：上线后评分开关的两个静默失效。
//   ①「跟随默认」如果发 undefined，mergeSettings 会跳过它保留旧值 ⇒ 从「开」切回来等于没切，
//     界面显示默认关、实际还在外发会话花额度。所以「跟随默认」必须是显式值 'auto'。
//   ② 界面经 ConfigService 存的是 <数据目录>/config.json；CLI 之前读 settings.json，
//     两端不同文件 ⇒ 用户按提示在界面开了，CLI 仍拒。
// 这两条都只有走真实 ConfigService 才咬得住——假的 merge 复现不出来。
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePostLaunchScoringEnabled } from '../../../../src/shared/contract/postLaunchScore';

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
    app: { isPackaged: false, getPath: () => dataDir },
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

async function service(dataDir: string) {
  const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
  const instance = new ConfigService();
  await instance.initialize();
  return instance;
}

const dataDir = () => mkdtemp(join(tmpdir(), 'code-agent-postlaunch-switch-'));

afterEach(() => {
  vi.doUnmock('../../../../src/host/platform');
  vi.doUnmock('../../../../src/host/services/core/secureStorage');
  vi.doUnmock('../../../../src/host/services/infra/logger');
  vi.doUnmock('../../../../src/host/permissions/policyEngine');
  vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
  vi.doUnmock('../../../../src/host/model/providers/shared');
  vi.resetModules();
});

describe('①「开 → 跟随默认」在宿主侧真的切回去了', () => {
  it("发显式 'auto' ⇒ 宿主不再是 'on'，外部机器解析成关", async () => {
    const dir = await dataDir();
    const config = await service(dir);

    await config.updateSettings({ privacy: { postLaunchScoring: 'on' } });
    expect(config.getSettings().privacy?.postLaunchScoring).toBe('on');
    expect(resolvePostLaunchScoringEnabled(config.getSettings().privacy?.postLaunchScoring, false)).toBe(true);

    await config.updateSettings({ privacy: { postLaunchScoring: 'auto' } });

    expect(config.getSettings().privacy?.postLaunchScoring).toBe('auto');
    // 外部机器（非内部槽）⇒ 跟随默认 = 关。切回来之后就不该再花额度了。
    expect(resolvePostLaunchScoringEnabled(config.getSettings().privacy?.postLaunchScoring, false)).toBe(false);
    // 落盘的也是 'auto'，不是残留的 'on'
    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8')) as {
      privacy?: { postLaunchScoring?: string };
    };
    expect(onDisk.privacy?.postLaunchScoring).toBe('auto');
  });

  it("反证：发 undefined 会被 mergeSettings 跳过，旧值 'on' 原样留着（所以不能用 undefined 表示跟随默认）", async () => {
    const dir = await dataDir();
    const config = await service(dir);

    await config.updateSettings({ privacy: { postLaunchScoring: 'on' } });
    await config.updateSettings({ privacy: { postLaunchScoring: undefined } });

    expect(config.getSettings().privacy?.postLaunchScoring).toBe('on');
    expect(resolvePostLaunchScoringEnabled(config.getSettings().privacy?.postLaunchScoring, false)).toBe(true);
  });
});

describe('②界面写的和 CLI 读的是同一个文件', () => {
  it('开关落在 <数据目录>/config.json；settings.json 根本没被创建', async () => {
    const dir = await dataDir();
    const config = await service(dir);

    await config.updateSettings({ privacy: { postLaunchScoring: 'on' } });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8')) as {
      privacy?: { postLaunchScoring?: string };
    };
    expect(onDisk.privacy?.postLaunchScoring).toBe('on');
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('CLI 走的 reloadFromDisk 读得到界面写下的开关（外部直接编辑 config.json 同理）', async () => {
    const dir = await dataDir();
    const config = await service(dir);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ privacy: { postLaunchScoring: 'on' } }));

    expect(await config.reloadFromDisk()).toBe(true);
    expect(config.getSettings().privacy?.postLaunchScoring).toBe('on');
    expect(resolvePostLaunchScoringEnabled(config.getSettings().privacy?.postLaunchScoring, false)).toBe(true);
  });
});
