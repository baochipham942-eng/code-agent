// ============================================================================
// N-DELIVERABLE-WORKDIR-LAZY rework r2：懒开目录落盘的撞名留痕。运行开始前
// （agent preflight）的改道收不到「规划期竞态当轮就开写」的残余——目录已存在、
// 非空、又被其它会话行同时记下时，本轮 cwd 已不可变（run-scoped ToolExecutor），
// 写入必混。这里至少钉住留痕：warn 一条可区分的日志，下一轮 preflight 会切走；
// 正常复用（无其它会话占用/空目录/缺失建目录）不打扰。
// ============================================================================
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

import { materializeRunWorkDirectoryOnce } from '../../../src/host/agent/runtime/workDirectoryMaterializer';
import { getDefaultWorkDirectory } from '../../../src/host/config/configPaths';

describe('materializeRunWorkDirectoryOnce collision trace (rework r2)', () => {
  let tempHome: string;
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
