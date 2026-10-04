import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import {
  beginArtifactRefresh,
  finishArtifactRefresh,
} from '../../../src/host/cron/artifactStandingRefresh';
import { listPublishedVersions } from '../../../src/host/tools/document/snapshotManager';

// 常设刷新 host 段：真临时目录 + 真 snapshotManager（快照/留版原语不做 mock），
// 只把 updateJob 换成捕获调用的 spy。
type JobUpdatePayload = Parameters<Parameters<typeof finishArtifactRefresh>[1]['updateJob']>[0];
type UpdateJobSpy = Mock<(updates: JobUpdatePayload) => Promise<unknown>>;

function refreshJob(filePath: string, metadataExtra: Record<string, unknown> = {}): CronJobDefinition {
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
      ...metadataExtra,
    },
  };
}

function plainJob(): CronJobDefinition {
  return {
    id: 'job-plain',
    name: 'Plain agent job',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'agent', agentType: 'default', prompt: 'work' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('artifactStandingRefresh host 执行段', () => {
  let workDir: string;
  let target: string;
  let updateJob: UpdateJobSpy;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'standing-refresh-test-'));
    target = join(workDir, 'dashboard.json');
    await writeFile(target, '{"title":"v1"}\n');
    updateJob = vi.fn<(updates: JobUpdatePayload) => Promise<unknown>>(async () => undefined);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('成功且内容有变：出一个已发布版本，不写任务、无标注', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    expect(state).toBeDefined();
    await writeFile(target, '{"title":"v2"}\n');

    await finishArtifactRefresh(state!, { runFailed: false, updateJob });

    const versions = listPublishedVersions(target);
    expect(versions).toHaveLength(1);
    expect(versions[0].note).toMatch(/^standing refresh /);
    expect(updateJob).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf-8')).toBe('{"title":"v2"}\n');
  });

  it('成功但内容未变：不留版本、不写任务', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    await finishArtifactRefresh(state!, { runFailed: false, updateJob });
    expect(listPublishedVersions(target)).toHaveLength(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('运行中途失败留下半截文件：字节级回滚到跑前内容并标注 lastRefreshFailed', async () => {
    const before = await readFile(target, 'utf-8');
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, '{"title":"v2","half":'); // 半截 JSON

    await finishArtifactRefresh(state!, { runFailed: true, error: new Error('model exploded'), updateJob });

    expect(await readFile(target, 'utf-8')).toBe(before);
    expect(updateJob).toHaveBeenCalledTimes(1);
    const updates = updateJob.mock.calls[0][0] as { metadata?: { artifactRefresh?: { lastRefreshFailed?: { reason: string } } } };
    expect(updates.metadata?.artifactRefresh?.lastRefreshFailed?.reason).toContain('model exploded');
  });

  it('成功但产物是坏 JSON：按失败处理并回滚', async () => {
    const before = await readFile(target, 'utf-8');
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, '{"title": "v2", broken');

    await finishArtifactRefresh(state!, { runFailed: false, updateJob });

    expect(await readFile(target, 'utf-8')).toBe(before);
    const updates = updateJob.mock.calls[0][0] as { metadata?: { artifactRefresh?: { lastRefreshFailed?: { reason: string } } } };
    expect(updates.metadata?.artifactRefresh?.lastRefreshFailed?.reason).toMatch(/json/i);
    expect(listPublishedVersions(target)).toHaveLength(0);
  });

  it('成功但产物是空文件：按失败处理并回滚', async () => {
    const before = await readFile(target, 'utf-8');
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, '');

    await finishArtifactRefresh(state!, { runFailed: false, updateJob });

    expect(await readFile(target, 'utf-8')).toBe(before);
    expect(updateJob).toHaveBeenCalledTimes(1);
  });

  it('成功但 docx 缺 zip 魔数：按失败处理并回滚；带 PK 魔数则通过', async () => {
    const docx = join(workDir, 'report.docx');
    await writeFile(docx, Buffer.from('PK\x03\x04docx-bytes'));
    const badState = beginArtifactRefresh(refreshJob(docx));
    await writeFile(docx, Buffer.from('not a zip at all'));

    await finishArtifactRefresh(badState!, { runFailed: false, updateJob });

    expect(await readFile(docx)).toEqual(Buffer.from('PK\x03\x04docx-bytes'));
    expect(updateJob).toHaveBeenCalledTimes(1);

    updateJob.mockClear();
    const goodState = beginArtifactRefresh(refreshJob(docx));
    await writeFile(docx, Buffer.from('PK\x05\x06docx-v2'));
    await finishArtifactRefresh(goodState!, { runFailed: false, updateJob });
    expect(listPublishedVersions(docx)).toHaveLength(1);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('失败标注写回时浅合并：metadata 里其他键原样保留', async () => {
    const job = refreshJob(target, { otherKey: 'keep-me' });
    const state = beginArtifactRefresh(job);
    await writeFile(target, 'half');

    await finishArtifactRefresh(state!, { runFailed: true, error: new Error('x'), updateJob });

    const updates = updateJob.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    expect(updates.metadata?.otherKey).toBe('keep-me');
    expect((updates.metadata?.artifactRefresh as Record<string, unknown>).path).toBe(target);
  });

  it('失败后的第二次成功刷新：清掉 lastRefreshFailed，不留空键', async () => {
    const job: CronJobDefinition = {
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
    const state = beginArtifactRefresh(job);
    await writeFile(target, '{"title":"v2"}\n');

    await finishArtifactRefresh(state!, { runFailed: false, updateJob });

    expect(updateJob).toHaveBeenCalledTimes(1);
    const updates = updateJob.mock.calls[0][0] as { metadata?: { artifactRefresh?: Record<string, unknown> } };
    expect(updates.metadata?.artifactRefresh).toEqual({
      path: target,
      instruction: 'refresh it',
      cadence: 'hourly',
    });
    expect('lastRefreshFailed' in (updates.metadata?.artifactRefresh ?? {})).toBe(false);
    expect(listPublishedVersions(target)).toHaveLength(1);
  });

  it('成功且无历史标注：完全不写任务（不给每趟成功制造 cron 实例重启）', async () => {
    const state = beginArtifactRefresh(refreshJob(target));
    await writeFile(target, '{"title":"v2"}\n');
    await finishArtifactRefresh(state!, { runFailed: false, updateJob });
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('非刷新任务：begin 返回 undefined，不建快照不碰文件', async () => {
    const before = await readFile(target, 'utf-8');
    expect(beginArtifactRefresh(plainJob())).toBeUndefined();
    expect(beginArtifactRefresh(refreshJob(join(workDir, 'missing.json')))).toBeUndefined();
    expect(await readFile(target, 'utf-8')).toBe(before);
    expect(listPublishedVersions(target)).toHaveLength(0);
  });
});
