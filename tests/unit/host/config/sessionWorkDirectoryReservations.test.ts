// ============================================================================
// N-DELIVERABLE-WORKDIR-LAZY rework r2：懒开目录的撞名占用集。会话行里已记下的
// workingDirectory（可能尚未落盘）要当成名字占用交给规划器。本文件钉：
// - 只留默认工作根之内的绝对路径（去重、trim），根本身不算占用；
// - exceptSessionId 透传给会话库（排除自己的占用）；
// - 会话库读不了时按无占用降级并留 warn，不把目录规划炸掉。
// databaseService 按需动态 import，这里整模块 mock，不碰真实 sqlite。
// ============================================================================
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  listRecordedWorkingDirectories: vi.fn<(exceptSessionId?: string) => string[]>(),
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    listRecordedWorkingDirectories: dbMocks.listRecordedWorkingDirectories,
  }),
}));

import { listSessionWorkDirectoryReservations } from '../../../../src/host/config/sessionWorkDirectoryReservations';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';

describe('listSessionWorkDirectoryReservations (rework r2)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = await mkdtemp(path.join(tmpdir(), 'workdir-reservations-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
    expect(root).toBe(path.join(tempHome, 'Neo'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('returns deduped absolute paths recorded inside the default work root', async () => {
    const insideA = path.join(root, '任务_1011_整理纪要');
    dbMocks.listRecordedWorkingDirectories.mockReturnValue([
      insideA,
      `  ${path.join(root, '任务_1011_写周报')}  `,
      insideA, // 重复记下 → 去重
      path.join(tempHome, 'elsewhere', '别的目录'), // 根之外 → 撞不到候选名
      '', // 空串 → 跳过
    ]);
    await expect(listSessionWorkDirectoryReservations({ env })).resolves.toEqual([
      path.resolve(insideA),
      path.resolve(path.join(root, '任务_1011_写周报')),
    ]);
  });

  it('never treats the default work root itself as occupied', async () => {
    dbMocks.listRecordedWorkingDirectories.mockReturnValue([root]);
    await expect(listSessionWorkDirectoryReservations({ env })).resolves.toEqual([]);
  });

  it('passes exceptSessionId through to the session store', async () => {
    dbMocks.listRecordedWorkingDirectories.mockReturnValue([]);
    await listSessionWorkDirectoryReservations({ env, exceptSessionId: 'session-1' });
    expect(dbMocks.listRecordedWorkingDirectories).toHaveBeenCalledWith('session-1');
  });

  it('degrades to no reservations (with a warn) when the session store cannot be read', async () => {
    dbMocks.listRecordedWorkingDirectories.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    await expect(listSessionWorkDirectoryReservations({ env })).resolves.toEqual([]);
  });
});
