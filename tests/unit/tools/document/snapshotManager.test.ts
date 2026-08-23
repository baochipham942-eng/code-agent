import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSnapshot,
  getPublishState,
  listPublishedVersions,
  listSnapshots,
  publishVersion,
} from '../../../../src/host/tools/document/snapshotManager';

describe('document published snapshots', () => {
  let workDir: string;
  let filePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'published-snapshot-'));
    filePath = join(workDir, 'report.md');
    await writeFile(filePath, 'version one');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates read-only published snapshots with incrementing version numbers outside the edit quota', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);

    const first = publishVersion(filePath, 'client copy');
    await writeFile(filePath, 'version two');
    const second = publishVersion(filePath);
    for (let index = 0; index < 21; index += 1) createSnapshot(filePath, `edit-${index}`);

    expect(first).toMatchObject({ version: 1, note: 'client copy' });
    expect(second.version).toBe(2);
    expect((await stat(first.snapshotPath)).mode & 0o222).toBe(0);
    expect(await readFile(first.snapshotPath, 'utf8')).toBe('version one');
    expect(listPublishedVersions(filePath).map((item) => item.version)).toEqual([2, 1]);
    expect(listSnapshots(filePath)).toHaveLength(20);
  });

  it('derives unpublished changes from current file content', async () => {
    expect(getPublishState(filePath)).toEqual({ kind: 'draft' });

    const first = publishVersion(filePath);
    expect(getPublishState(filePath)).toEqual({
      kind: 'published',
      version: 1,
      publishedAt: first.publishedAt,
    });

    await writeFile(filePath, 'edited working copy');
    expect(getPublishState(filePath).kind).toBe('published-dirty');

    publishVersion(filePath);
    expect(getPublishState(filePath).kind).toBe('published');
  });
});
