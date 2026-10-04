// N-ARTIFACT-STANDING-REFRESH：getPublishInfo 的 standingRefresh 扩展。
// 走真实 workspace 域路由表（registerWorkspaceHandlers.routes.actions），
// 只把 cron 任务来源（getCronService.listJobs / loadCronLastRunAt）替身掉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cronState = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  lastRunAt: {} as Record<string, number>,
}));

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({ listJobs: () => cronState.jobs }),
}));

vi.mock('../../../src/host/cron/cronPersistence', () => ({
  loadCronLastRunAt: (jobId: string) => cronState.lastRunAt[jobId],
}));

import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';

const getPublishInfo = (registerWorkspaceHandlers.routes as unknown as {
  actions: Record<string, (ctx: unknown, payload: unknown) => Promise<Record<string, unknown>>>;
}).actions.getPublishInfo;

describe('workspace getPublishInfo · standingRefresh', () => {
  let workDir: string;
  let target: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'publish-info-refresh-'));
    target = join(workDir, 'dashboard.json');
    await writeFile(target, '{"title":"v1"}\n');
    cronState.jobs = [];
    cronState.lastRunAt = {};
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('同路径的 artifact-refresh 任务在场：返回 standingRefresh 视图', async () => {
    cronState.jobs = [{
      id: 'job-1',
      enabled: true,
      updatedAt: 5,
      metadata: {
        artifactRefresh: { path: target, instruction: 'refresh it', cadence: 'weekly' },
      },
    }];
    cronState.lastRunAt['job-1'] = 4242;

    const info = await getPublishInfo(undefined, { filePath: target });

    expect(info.standingRefresh).toEqual({
      jobId: 'job-1',
      enabled: true,
      cadence: 'weekly',
      instruction: 'refresh it',
      lastRunAt: 4242,
    });
    // 既有字段不受影响（版本面照常来自 snapshotManager）
    expect(info.publishState).toEqual({ kind: 'draft' });
    expect(info.publishedVersions).toEqual([]);
  });

  it('路径不一致或没有任务：standingRefresh 键缺省（不是 null）', async () => {
    cronState.jobs = [{
      id: 'job-2',
      enabled: true,
      updatedAt: 5,
      metadata: { artifactRefresh: { path: '/tmp/other.json', instruction: 'x', cadence: 'daily' } },
    }];

    const info = await getPublishInfo(undefined, { filePath: target });

    expect('standingRefresh' in info).toBe(false);
    expect(info.publishState).toEqual({ kind: 'draft' });
  });

  it('失败标注透传到视图', async () => {
    cronState.jobs = [{
      id: 'job-3',
      enabled: false,
      updatedAt: 5,
      metadata: {
        artifactRefresh: {
          path: target,
          instruction: 'refresh it',
          cadence: 'daily',
          lastRefreshFailed: { at: 99, reason: 'agent run failed: boom' },
        },
      },
    }];

    const info = await getPublishInfo(undefined, { filePath: target });

    expect(info.standingRefresh).toMatchObject({
      jobId: 'job-3',
      enabled: false,
      lastRefreshFailed: { at: 99, reason: 'agent run failed: boom' },
    });
  });
});
