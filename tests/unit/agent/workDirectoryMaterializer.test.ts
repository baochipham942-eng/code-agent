// ============================================================================
// N-DELIVERABLE-WORKDIR-LAZY rework r2：懒开目录落盘的撞名留痕。运行开始前
// （agent preflight）的改道收不到「规划期竞态当轮就开写」的残余——目录已存在、
// 非空、又被其它会话行同时记下时，本轮 cwd 已不可变（run-scoped ToolExecutor），
// 写入必混。这里至少钉住留痕：warn 一条可区分的日志，下一轮 preflight 会切走；
// 正常复用（无其它会话占用/空目录/缺失建目录）不打扰。
// ============================================================================
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reservations: vi.fn<() => Promise<string[]>>(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../src/host/config/sessionWorkDirectoryReservations', () => ({
  listSessionWorkDirectoryReservations: mocks.reservations,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.info,
    warn: mocks.warn,
    error: vi.fn(),
  }),
}));

import {
  beginWorkDirectoryRun,
  endWorkDirectoryRun,
  materializeRunWorkDirectoryOnce,
  sweepOrphanMetadataOnlyWorkDirectories,
} from '../../../src/host/agent/runtime/workDirectoryMaterializer';
import { getDefaultWorkDirectory } from '../../../src/host/config/configPaths';

describe('materializeRunWorkDirectoryOnce collision trace (rework r2)', () => {  let tempHome: string;
  let root: string;
  let priorEnv: { CODE_AGENT_HOME?: string; CODE_AGENT_DATA_DIR?: string };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reservations.mockResolvedValue([]);
    tempHome = await mkdtemp(path.join(tmpdir(), 'workdir-materializer-'));
    priorEnv = {
      CODE_AGENT_HOME: process.env.CODE_AGENT_HOME,
      CODE_AGENT_DATA_DIR: process.env.CODE_AGENT_DATA_DIR,
    };
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, '.code-agent');
    root = getDefaultWorkDirectory();
    expect(root).toBe(path.join(tempHome, 'Neo'));
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('warns when the existing non-empty planned dir is also recorded by another session', async () => {
    const dir = path.join(root, '任务_1011_混写');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '别人的产出.md'), 'x');
    mocks.reservations.mockResolvedValue([dir]);

    await materializeRunWorkDirectoryOnce(dir, { sessionId: 'session-b' });

    expect(mocks.reservations).toHaveBeenCalledWith({ exceptSessionId: 'session-b' });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('also recorded by another session'),
    );
    // 只留痕：既不搬家也不动内容
    await expect(readdir(dir)).resolves.toEqual(['别人的产出.md']);
  });

  it('stays quiet for a non-empty dir no other session claims (normal next-day reuse)', async () => {
    const dir = path.join(root, '任务_1011_复用');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '自己的产出.md'), 'x');

    await materializeRunWorkDirectoryOnce(dir, { sessionId: 'session-a' });

    expect(mocks.reservations).toHaveBeenCalledTimes(1);
    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('also recorded by another session'),
    );
  });

  it('does not consult reservations for an existing empty dir', async () => {
    const dir = path.join(root, '任务_1011_空目录');
    await mkdir(dir, { recursive: true });

    await materializeRunWorkDirectoryOnce(dir, { sessionId: 'session-a' });

    expect(mocks.reservations).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('materializes a missing planned dir and stays quiet', async () => {
    const dir = path.join(root, '任务_1011_新任务');

    await materializeRunWorkDirectoryOnce(dir, { sessionId: 'session-a' });

    await expect(readdir(dir)).resolves.toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('never touches paths outside the default work root', async () => {
    const outside = path.join(tempHome, 'elsewhere', 'project');

    await materializeRunWorkDirectoryOnce(outside, { sessionId: 'session-a' });

    await expect(readdir(path.join(tempHome, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.reservations).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-DELEGATE-WORKDIR-LAZY-FU1-FU1-FU2：启动孤儿清扫。挂死的子代理 run 永不触发
// endWorkDirectoryRun，进程重启后 createdByThisProcess（内存）失忆，运行期回收路径
// 永不认领 case e 形状的元数据夹。sweepOrphanMetadataOnlyWorkDirectories 只删
// 同时满足全部条件的默认工作根直接子项：规划形状（isPlannedSessionWorkDirectory）、
// 只剩元数据（isOnlyCodeAgentMetadata 单一真源）、不在 activeRuns、lstat mtime
// 早于 1 小时。任何用户文件、未清快照、符号链接、非规划名、根外路径、太新的夹子
// 一律不动。
// ============================================================================
describe('sweepOrphanMetadataOnlyWorkDirectories (startup sweep)', () => {
  const MODULE_PATH = '../../../src/host/agent/runtime/workDirectoryMaterializer';
  let tempHome: string;
  let root: string;
  let priorEnv: { CODE_AGENT_HOME?: string; CODE_AGENT_DATA_DIR?: string };

  const backdateTwoHours = async (dir: string): Promise<void> => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, past, past);
  };

  /** case e 形状：规划名 + 只剩 `.code-agent/stream-snapshots` 空脚手架，无用户文件。 */
  const makeOrphanShape = async (name: string, parent = root): Promise<string> => {
    const dir = path.join(parent, name);
    await mkdir(path.join(dir, '.code-agent', 'stream-snapshots'), { recursive: true });
    await backdateTwoHours(dir);
    return dir;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = await mkdtemp(path.join(tmpdir(), 'workdir-sweep-'));
    priorEnv = {
      CODE_AGENT_HOME: process.env.CODE_AGENT_HOME,
      CODE_AGENT_DATA_DIR: process.env.CODE_AGENT_DATA_DIR,
    };
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, '.code-agent');
    root = getDefaultWorkDirectory();
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // ① 挂死 run + 重启（vi.resetModules 清空模块级内存）后，孤儿夹在下次启动被清掉。
  it('removes the restart orphan on the next start (vi.resetModules restart)', async () => {
    // 旧进程：begin 后 run 永不返回（挂死），目录已落盘并长出快照脚手架。
    const hungDir = path.join(root, '任务_1105_挂死孤儿');
    beginWorkDirectoryRun(hungDir);
    await materializeRunWorkDirectoryOnce(hungDir, { sessionId: 'session-hung' });
    await mkdir(path.join(hungDir, '.code-agent', 'stream-snapshots'), { recursive: true });
    await backdateTwoHours(hungDir);

    // 重启：模块注册表清空 → createdByThisProcess / activeRuns 全部归零。
    vi.resetModules();
    const fresh = await import(MODULE_PATH);

    // 重启探针（父单 case e 同款）：新进程 begin+end 同一目录，回收路径因
    // createdByThisProcess 为空直接放行——夹子还在，证明内存真的清空了。
    fresh.beginWorkDirectoryRun(hungDir);
    fresh.endWorkDirectoryRun(hungDir);
    await expect(stat(hungDir)).resolves.toBeTruthy();

    // 下次启动的清扫不依赖那块内存：照样认领并删除。
    await expect(fresh.sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(1);
    await expect(stat(hungDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('Swept orphan metadata-only session work dir'));
  });

  // ② case d：未清除的断流快照是恢复证据，不清扫。
  it('leaves a folder holding an uncleared stream snapshot (case d)', async () => {
    const dir = await makeOrphanShape('任务_1105_断流快照');
    await mkdir(path.join(dir, '.code-agent', 'stream-snapshots', 'c2Vzc2lvbg'), { recursive: true });
    await writeFile(path.join(dir, '.code-agent', 'stream-snapshots', 'c2Vzc2lvbg', 'run-partial.jsonl'), '{}');

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('leaves a folder holding any user file', async () => {
    const dir = path.join(root, '任务_1105_有产出');
    await mkdir(path.join(dir, '.code-agent'), { recursive: true });
    await writeFile(path.join(dir, 'report.md'), '# user content');
    await backdateTwoHours(dir);

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('leaves a symlink alone and never follows it', async () => {
    const realDir = await makeOrphanShape('任务_1105_真实夹', path.join(tempHome, 'outside-root'));
    const link = path.join(root, '任务_1105_符号链接');
    await symlink(realDir, link);

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(stat(realDir)).resolves.toBeTruthy();
  });

  it('leaves a non-planned folder name alone', async () => {
    const dir = await makeOrphanShape('random-notes');

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('leaves a folder outside the default work root alone', async () => {
    const dir = await makeOrphanShape('任务_1105_根外', path.join(tempHome, 'elsewhere'));

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('leaves a folder younger than the age guard alone', async () => {
    // 不回拨 mtime：刚刚创建，早于 1 小时年龄档。
    const dir = path.join(root, '任务_1105_太新');
    await mkdir(path.join(dir, '.code-agent', 'stream-snapshots'), { recursive: true });

    await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('leaves a folder with an active run alone', async () => {
    const dir = await makeOrphanShape('任务_1105_运行中');
    beginWorkDirectoryRun(dir);

    try {
      await expect(sweepOrphanMetadataOnlyWorkDirectories()).resolves.toBe(0);
      await expect(stat(dir)).resolves.toBeTruthy();
    } finally {
      endWorkDirectoryRun(dir);
    }
  });
});
