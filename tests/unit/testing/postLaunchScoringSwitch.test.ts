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
import { CONFIG_DIR_DEV, CONFIG_DIR_NEW } from '../../../src/shared/constants/configDir';

const getSettings = vi.fn();
const getUserDataPath = vi.fn();
const getDb = vi.fn();

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings }),
}));
// 内部槽判据只看数据目录名（devSlot.ts:99），所以这里换掉的是路径，不是插件运行时。
vi.mock('../../../src/host/platform', () => ({ getUserDataPath }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb }),
}));

/** 内部 dogfood 槽 = Rust dev_slot() 注入的数据目录名；外部机器就是普通 ~/.code-agent。 */
const INTERNAL_SLOT_DIR = path.join('/tmp', CONFIG_DIR_DEV);
const EXTERNAL_DIR = path.join('/tmp', CONFIG_DIR_NEW);

describe('上线后评分开关三态', () => {
  it("显式选择压过槽默认；'auto' 与老配置的缺省都按槽算", () => {
    expect(resolvePostLaunchScoringEnabled('on', false)).toBe(true);
    expect(resolvePostLaunchScoringEnabled('off', true)).toBe(false);
    expect(resolvePostLaunchScoringEnabled('auto', true)).toBe(true);
    expect(resolvePostLaunchScoringEnabled('auto', false)).toBe(false);
    // 老配置里没有这个键
    expect(resolvePostLaunchScoringEnabled(undefined, true)).toBe(true);
    expect(resolvePostLaunchScoringEnabled(undefined, false)).toBe(false);
  });
});

describe('关着的时候 IPC 评分被拒', () => {
  beforeEach(() => {
    vi.resetModules();
    getSettings.mockReset();
    getUserDataPath.mockReset();
    getDb.mockReset();
  });

  it('off ⇒ 拒评，报的是人话，而且一次都没碰数据库', async () => {
    getSettings.mockReturnValue({ privacy: { postLaunchScoring: 'off' } });
    getUserDataPath.mockReturnValue(INTERNAL_SLOT_DIR); // 就算是内部槽，显式 off 也得拒
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    await expect(runPostLaunchScoringOnHost({ days: 7 })).rejects.toThrow(POST_LAUNCH_DISABLED_MESSAGE);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("外部机器（非内部槽）选「跟随默认」⇒ 就是拒", async () => {
    getSettings.mockReturnValue({ privacy: { postLaunchScoring: 'auto' } });
    getUserDataPath.mockReturnValue(EXTERNAL_DIR);
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    await expect(runPostLaunchScoringOnHost()).rejects.toThrow(POST_LAUNCH_DISABLED_MESSAGE);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('内部槽没设置过 ⇒ 默认开（门放行，往下才去要数据库）', async () => {
    getSettings.mockReturnValue({});
    getUserDataPath.mockReturnValue(INTERNAL_SLOT_DIR);
    getDb.mockReturnValue(null); // 门放行之后才会报「数据库尚未就绪」
    const { runPostLaunchScoringOnHost } = await import('../../../src/host/testing/postlaunch/postLaunchScorerRuntime');

    // 门放行了才会走到取数据库这一步——报错换成「数据库尚未就绪」本身就是「没被门拦住」的证据。
    await expect(runPostLaunchScoringOnHost()).rejects.toThrow('数据库尚未就绪');
    expect(getDb).toHaveBeenCalled();
  });
});
