// ============================================================================
// Artifact Standing Refresh - 结算段回归（PR review 返修）
// ① 结算底稿必须重读任务当前 metadata：一趟 agent 跑数分钟，用户可能中途在产物
//    弹窗保存新指令/节奏（那条保存也是 updateJob 顶层整体替换 metadata）；拿跑前
//    快照当底稿写回会静默回退用户的在途修改。
// ② 成功分支的哈希+留版不得让异常冒泡：走到这里文件已刷新且校验通过，留版 IO
//    失败只降级为日志——不把整趟判死（结果照常投递），也不写语义为"保持上一版"
//    的 lastRefreshFailed 标注去误导用户。
// 快照/回滚原语仍走真实现；仅 publishVersion 可编程抛错。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/host/cron/cronPersistence', () => ({
  loadCronLastRunAt: () => undefined,
}));

const publishVersionGate = vi.hoisted(() => ({ failWith: null as string | null }));

vi.mock('../../../src/host/tools/modules/document/publishedVersions', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/tools/modules/document/publishedVersions')
  >();
  return {
    ...actual,
    publishVersion: (...args: Parameters<typeof actual.publishVersion>) => {
      if (publishVersionGate.failWith) throw new Error(publishVersionGate.failWith);
      return actual.publishVersion(...args);
    },
  };
});

import {
  beginArtifactRefresh,
  finishArtifactRefresh,
} from '../../../src/host/cron/artifactStandingRefresh';

type JobUpdatePayload = Parameters<NonNullable<Parameters<typeof finishArtifactRefresh>[1]['updateJob']>>[0];
type UpdateJobSpy = Mock<(updates: JobUpdatePayload) => Promise<unknown>>;

function refreshJob(filePath: string): CronJobDefinition {
  return {
    id: 'job-refresh-1',
    name: 'Refresh target',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'agent', agentType: 'default', prompt: 'work' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      artifactRefresh: { path: filePath, instruction: 'refresh it', cadence: 'hourly' },
    },
  };
}

/** 跑了几分钟后用户在产物弹窗保存过的任务：新指令、新节奏、多了一个 metadata 键。 */
function jobAfterUserEdit(filePath: string, extraRefresh: Record<string, unknown> = {}): CronJobDefinition {
  return {
    ...refreshJob(filePath),
    metadata: {
      artifactRefresh: {
        path: filePath,
        instruction: 'collect this week progress and update the three numbers',
        cadence: 'weekly',
        ...extraRefresh,
      },
      userFlag: 'keep-me',
    },
  };
}

function markerPayload(metadata: Record<string, unknown> | undefined): {
  artifactRefresh?: { instruction?: string; cadence?: string; lastRefreshFailed?: { reason?: string } };
  userFlag?: string;
} {
  return (metadata ?? {}) as { artifactRefresh?: { instruction?: string; cadence?: string; lastRefreshFailed?: { reason?: string } }; userFlag?: string };
}

describe('artifactStandingRefresh 结算段（metadata 重读 + 留版降级）', () => {
  let workDir: string;
  let target: string;
  let updateJob: UpdateJobSpy;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'standing-refresh-settle-'));
    target = join(workDir, 'dashboard.json');
    await writeFile(target, '{"title":"v1"}\n');
    updateJob = vi.fn<(updates: JobUpdatePayload) => Promise<unknown>>(async () => undefined);
  });

  afterEach(async () => {
    publishVersionGate.failWith = null;
    await rm(workDir, { recursive: true, force: true });
  });

  it('失败标注以结算时重读的任务 metadata 为底稿：不回退用户跑中保存的新指令/节奏', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    expect(state).toBeDefined();
    await writeFile(target, '{"title":"v2","half'); // 半截产物

    await finishArtifactRefresh(state!, {
      runFailed: true,
      error: new Error('model exploded'),
      updateJob,
      loadJob: () => jobAfterUserEdit(target),
    });

    expect(await readFile(target, 'utf-8')).toBe('{"title":"v1"}\n');
    expect(updateJob).toHaveBeenCalledTimes(1);
    const updates = updateJob.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    const payload = markerPayload(updates.metadata);
    expect(payload.artifactRefresh?.instruction).toBe('collect this week progress and update the three numbers');
    expect(payload.artifactRefresh?.cadence).toBe('weekly');
    expect(payload.artifactRefresh?.lastRefreshFailed?.reason).toContain('model exploded');
    expect(payload.userFlag).toBe('keep-me');
  });

  it('成功清标注同样以当前 metadata 为底稿：保留用户跑中改过的新指令，清掉 lastRefreshFailed', async () => {
    const failedBefore: CronJobDefinition = {
      ...refreshJob(target),
      metadata: {
        artifactRefresh: {
          path: target,
          instruction: 'refresh it',
          cadence: 'hourly',
          lastRefreshFailed: { at: 111, reason: 'agent run failed: old' },
        },
      },
    };
    const state = beginArtifactRefresh(failedBefore);
    await writeFile(target, '{"title":"v2"}\n');

    const editedNow = jobAfterUserEdit(target, { lastRefreshFailed: { at: 111, reason: 'agent run failed: old' } });

    await finishArtifactRefresh(state!, { runFailed: false, updateJob, loadJob: () => editedNow });

    expect(updateJob).toHaveBeenCalledTimes(1);
    const updates = updateJob.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    const payload = markerPayload(updates.metadata);
    expect(payload.artifactRefresh?.instruction).toBe('collect this week progress and update the three numbers');
    expect(payload.artifactRefresh?.cadence).toBe('weekly');
    expect(payload.artifactRefresh?.lastRefreshFailed).toBeUndefined();
    expect(payload.userFlag).toBe('keep-me');
  });

  it('成功分支留版 IO 失败：不冒泡、不写失败标注、文件保持刷新后的新内容、日志留痕', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, '{"title":"v2"}\n');
    publishVersionGate.failWith = 'simulated disk full while storing the version';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        finishArtifactRefresh(state!, { runFailed: false, updateJob, loadJob: () => refreshJob(target) }),
      ).resolves.toBeUndefined();
      expect(await readFile(target, 'utf-8')).toBe('{"title":"v2"}\n');
      expect(updateJob).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('任务跑中被删（loadJob 落空）：回退跑前快照底稿，结算本身不抛', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, 'half');

    await expect(
      finishArtifactRefresh(state!, { runFailed: true, error: new Error('x'), updateJob, loadJob: () => undefined }),
    ).resolves.toBeUndefined();

    expect(await readFile(target, 'utf-8')).toBe('{"title":"v1"}\n');
    expect(updateJob).toHaveBeenCalledTimes(1);
    const updates = updateJob.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    const payload = markerPayload(updates.metadata);
    expect(payload.artifactRefresh?.instruction).toBe('refresh it');
  });

  it('loadJob 自身抛错：降级回跑前快照底稿，结算不抛且留可区分的 warn', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, 'half');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        finishArtifactRefresh(state!, {
          runFailed: true,
          error: new Error('x'),
          updateJob,
          loadJob: () => { throw new Error('ipc hiccup'); },
        }),
      ).resolves.toBeUndefined();
      expect(updateJob).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
