// 三态开关（ADR-063 §3 · N-EVAL-POSTLAUNCH-K2 验收⑧）：
// 显式 on/off 说了算；不设置就按槽算（内部 dogfood 槽开、外部关）。
// 关着的时候 IPC「评近 N 天」这条路必须在碰数据库和模型之前就拒掉，并且给的是人话。
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CODE_AGENT_DATA_DIR = path.join(os.tmpdir(), `postlaunch-switch-${process.pid}`);

import {
  POST_LAUNCH_DISABLED_MESSAGE,
  resolvePostLaunchScoringEnabled,
} from '../../../src/shared/contract/postLaunchScore';

const getSettings = vi.fn();
const isLoaded = vi.fn();
const getDb = vi.fn();

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings }),
}));
vi.mock('../../../src/host/internalFeatures/internalFeatureHostRuntime', () => ({
  getInternalFeatureHostRuntime: () => ({ isLoaded }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb }),
}));

describe('上线后评分开关三态', () => {
  it('显式选择压过槽默认；不设置才按槽算', () => {
    expect(resolvePostLaunchScoringEnabled('on', false)).toBe(true);
    expect(resolvePostLaunchScoringEnabled('off', true)).toBe(false);
    expect(resolvePostLaunchScoringEnabled(undefined, true)).toBe(true);
    expect(resolvePostLaunchScoringEnabled(undefined, false)).toBe(false);
  });
});

describe('关着的时候 IPC 评分被拒', () => {
  beforeEach(() => {
    vi.resetModules();
    getSettings.mockReset();
    isLoaded.mockReset();
    getDb.mockReset();
  });

  it('off ⇒ 拒评，报的是人话，而且一次都没碰数据库', async () => {
    getSettings.mockReturnValue({ privacy: { postLaunchScoring: 'off' } });
    isLoaded.mockReturnValue(true); // 就算是内部槽，显式 off 也得拒
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    await expect(runPostLaunchScoringOnHost({ days: 7 })).rejects.toThrow(POST_LAUNCH_DISABLED_MESSAGE);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('外部机器（非内部槽）没设置过 ⇒ 默认就是拒', async () => {
    getSettings.mockReturnValue({});
    isLoaded.mockReturnValue(false);
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    await expect(runPostLaunchScoringOnHost()).rejects.toThrow(POST_LAUNCH_DISABLED_MESSAGE);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('内部槽没设置过 ⇒ 默认开（门放行，往下才去要数据库）', async () => {
    getSettings.mockReturnValue({});
    isLoaded.mockReturnValue(true);
    getDb.mockReturnValue(null); // 门放行之后才会报「数据库尚未就绪」
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    // 门放行了才会走到取数据库这一步——报错换成「数据库尚未就绪」本身就是「没被门拦住」的证据。
    await expect(runPostLaunchScoringOnHost()).rejects.toThrow('数据库尚未就绪');
    expect(getDb).toHaveBeenCalled();
  });
});
