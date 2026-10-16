import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSnapshot,
  getPublishState,
  listPublishedVersions,
  listSnapshots,
  loadMeta,
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

describe('meta keyed by full file name (same base name, different extensions)', () => {
  let workDir: string;
  let mdPath: string;
  let docxPath: string;
  let snapshotDir: string;
  let legacyMetaPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'meta-full-name-'));
    mdPath = join(workDir, 'status.md');
    docxPath = join(workDir, 'status.docx');
    await writeFile(mdPath, 'md body v1');
    await writeFile(docxPath, 'docx body v1');
    snapshotDir = join(workDir, '.doc-snapshots');
    await mkdir(snapshotDir, { recursive: true });
    legacyMetaPath = join(snapshotDir, 'status.meta.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('keys each file its own meta file so published versions and edit snapshots never mix', async () => {
    publishVersion(docxPath, 'docx one');
    await writeFile(docxPath, 'docx body v2');
    publishVersion(docxPath, 'docx two');
    publishVersion(mdPath, 'md one');
    createSnapshot(mdPath, 'md edit');

    expect(listPublishedVersions(docxPath).map((item) => item.version)).toEqual([2, 1]);
    expect(listPublishedVersions(mdPath).map((item) => item.version)).toEqual([1]);
    expect(listSnapshots(mdPath)).toHaveLength(1);
    expect(listSnapshots(docxPath)).toHaveLength(0);

    const metaFiles = (await readdir(snapshotDir)).filter((name) => name.endsWith('.meta.json')).sort();
    expect(metaFiles).toEqual(['status.docx.meta.json', 'status.md.meta.json']);
  });

  it('splits a legacy shared meta read-only: own entries only, numbering kept, legacy file untouched', async () => {
    const legacyMeta = {
      snapshots: [
        {
          id: 'status-1',
          filePath: mdPath,
          snapshotPath: join(snapshotDir, 'status-1.md'),
          timestamp: 1_700_000_000_000,
          description: 'md edit',
          sizeBytes: 8,
        },
        {
          id: 'status-2',
          filePath: docxPath,
          snapshotPath: join(snapshotDir, 'status-2.docx'),
          timestamp: 1_700_000_100_000,
          description: 'docx edit',
          sizeBytes: 10,
        },
      ],
      publishedVersions: [
        { version: 1, publishedAt: 1_700_000_010_000, snapshotPath: join(snapshotDir, 'status.published-v1.md'), contentHash: 'md-1' },
        { version: 2, publishedAt: 1_700_000_020_000, snapshotPath: join(snapshotDir, 'status.published-v2.md'), contentHash: 'md-2' },
        { version: 3, publishedAt: 1_700_000_030_000, snapshotPath: join(snapshotDir, 'status.published-v3.md'), contentHash: 'md-3' },
        { version: 1, publishedAt: 1_700_000_040_000, snapshotPath: join(snapshotDir, 'status.published-v1.docx'), contentHash: 'docx-1' },
        { version: 2, publishedAt: 1_700_000_050_000, snapshotPath: join(snapshotDir, 'status.published-v2.docx'), contentHash: 'docx-2' },
        { version: 15, publishedAt: 1_700_000_150_000, snapshotPath: join(snapshotDir, 'status.published-v15.docx'), contentHash: 'docx-15' },
      ],
      share: {
        token: 'share-token',
        url: 'https://share.test/d/share-token',
        expiresAt: null,
        createdAt: 1_700_000_160_000,
        ttlSeconds: 604_800,
        pushedVersion: 15,
        pushedHash: 'docx-15',
      },
    };
    for (const entry of legacyMeta.publishedVersions) {
      await writeFile(entry.snapshotPath, `snapshot ${entry.version}`);
    }
    await writeFile(legacyMeta.snapshots[0].snapshotPath, 'md edit bytes');
    await writeFile(legacyMeta.snapshots[1].snapshotPath, 'docx edit bytes');
    await writeFile(legacyMetaPath, JSON.stringify(legacyMeta, null, 2));
    const legacyBefore = await readFile(legacyMetaPath, 'utf8');

    // 拆分读取：各自只看到自己的发布版与编辑快照；share 归 docx（pushed v15 是 docx 条目）
    expect(listPublishedVersions(docxPath).map((item) => item.version)).toEqual([15, 2, 1]);
    expect(listPublishedVersions(mdPath).map((item) => item.version)).toEqual([3, 2, 1]);
    expect(listSnapshots(mdPath).map((item) => item.id)).toEqual(['status-1']);
    expect(listSnapshots(docxPath).map((item) => item.id)).toEqual(['status-2']);
    expect(loadMeta(docxPath).share?.url).toBe('https://share.test/d/share-token');
    expect(loadMeta(mdPath).share).toBeUndefined();

    // 新发布落新键、编号接本文件自己的最大值；旧文件字节不动
    await writeFile(docxPath, 'docx body v16');
    expect(publishVersion(docxPath, 'after upgrade').version).toBe(16);
    await writeFile(mdPath, 'md body v4');
    expect(publishVersion(mdPath, 'after upgrade').version).toBe(4);

    const docxMeta = JSON.parse(await readFile(join(snapshotDir, 'status.docx.meta.json'), 'utf8'));
    expect(docxMeta.publishedVersions.map((item: { version: number }) => item.version)).toEqual([1, 2, 15, 16]);
    expect(docxMeta.share?.pushedVersion).toBe(15);
    const mdMeta = JSON.parse(await readFile(join(snapshotDir, 'status.md.meta.json'), 'utf8'));
    expect(mdMeta.publishedVersions.map((item: { version: number }) => item.version)).toEqual([1, 2, 3, 4]);
    expect(mdMeta.share).toBeUndefined();
    expect(await readFile(legacyMetaPath, 'utf8')).toBe(legacyBefore);
  });
});
