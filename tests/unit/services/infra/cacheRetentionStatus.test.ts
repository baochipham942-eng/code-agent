import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAppCacheRetentionStatus,
  sweepAppCacheRetention,
  type AppCacheDirSpec,
} from '../../../../src/host/services/infra/appCacheRetention';
import {
  getPresentationPreviewRetentionStatus,
  sweepPresentationPreviewRetention,
} from '../../../../src/host/services/infra/presentationPreviewRetention';
import {
  getCacheRetentionStatus,
  retryCacheRetentionSweeps,
} from '../../../../src/host/services/infra/cacheRetentionStatus';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

// 注入失败 = 引用扫描读不到库（两家都「本轮不删任何文件」并记 1 次失败）；
// 随后换成可用的库 + 空目录 = 完整干净的一轮，failedCurrent 必须归零、lastError 必须清掉。

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let dbPath: string;
let db: InstanceType<typeof Database>;
let appDirs: AppCacheDirSpec[];
let previewRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-retention-status-'));
  dbPath = path.join(root, 'code-agent.db');
  db = new Database(dbPath);
  applyTestSessionSchema(db);
  const channelMedia = path.join(root, 'channel-media');
  fs.mkdirSync(channelMedia, { recursive: true });
  appDirs = [{ kind: 'channel-media', root: channelMedia }];
  previewRoot = path.join(root, 'previews');
  const rev = path.join(previewRoot, 'a'.repeat(64));
  fs.mkdirSync(path.join(rev, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(rev, 'manifest.json'), JSON.stringify({ revision: 'a'.repeat(64), filePath: path.join(root, 'deck.pptx'), lastUsedAt: NOW - 40 * DAY_MS }));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const missingDb = () => path.join(root, 'no-such.db');

describe('app cache retention status', () => {
  it('注入失败 → failedCurrent>=1 且带 lastError；之后完整干净一轮 → failedCurrent=0、lastError 清空', async () => {
    await sweepAppCacheRetention({ dirs: appDirs, dbPath: missingDb(), now: NOW });
    const failed = getAppCacheRetentionStatus();
    expect(failed.failedCurrent).toBeGreaterThanOrEqual(1);
    expect(failed.lastError).toEqual(expect.any(String));

    await sweepAppCacheRetention({ dirs: appDirs, dbPath, now: NOW + 1 });
    const clean = getAppCacheRetentionStatus();
    expect(clean.failedCurrent).toBe(0);
    expect(clean.lastError).toBeUndefined();
    // 干净一轮 resetFailures：旧账累计一并清零（失败行不再报旧账）
    expect(clean.failedTotal).toBe(0);
  });

  it('同一批失败重试多次：failedCurrent 取本轮值而不是累加', async () => {
    await sweepAppCacheRetention({ dirs: appDirs, dbPath: missingDb(), now: NOW });
    await sweepAppCacheRetention({ dirs: appDirs, dbPath: missingDb(), now: NOW + 1 });
    const status = getAppCacheRetentionStatus();
    expect(status.failedCurrent).toBe(1);
    expect(status.failedTotal).toBeGreaterThanOrEqual(2);
  });
});

describe('presentation preview retention status', () => {
  it('注入失败 → failedCurrent>=1 且带 lastError；之后完整干净一轮 → failedCurrent=0、lastError 清空', async () => {
    await sweepPresentationPreviewRetention({ cacheRoot: previewRoot, dbPath: missingDb(), now: NOW });
    const failed = getPresentationPreviewRetentionStatus();
    expect(failed.failedCurrent).toBeGreaterThanOrEqual(1);
    expect(failed.lastError).toEqual(expect.any(String));

    // 空缓存根 = 无 revision 可扫的干净一轮（提前返回出口也必须清账）
    await sweepPresentationPreviewRetention({ cacheRoot: path.join(root, 'empty'), dbPath, now: NOW + 1 });
    const clean = getPresentationPreviewRetentionStatus();
    expect(clean.failedCurrent).toBe(0);
    expect(clean.lastError).toBeUndefined();
  });
});

// ============================================================================
// tool-screenshots 删除失败 → Settings > Data 失败行（N-RETENTION-APP-CACHES-REST2-FU1）
// 注入方式与上面不同：不是扫描读不到库，而是会话子目录 chmod 只读——候选 png
// 过龄未引用，unlink EPERM/EACCES 是「文件真的删不掉」的删除失败路径。
// 走聚合出口 getCacheRetentionStatus()（数据页失败行读的那份），且用全新模块图
// 把两家账本清零：断言 failedCurrent 恰为 1 = 失败只来自 tool-screenshots 这一 kind。
// ============================================================================
describe('tool-screenshots 删除失败进失败行', () => {
  it('只读会话目录里过龄 png 删不掉 → getCacheRetentionStatus() failedCurrent>=1 且带 lastError；恢复权限后干净一轮 → 归零', async () => {
    vi.resetModules();
    const { sweepAppCacheRetention: freshSweep } = await import('../../../../src/host/services/infra/appCacheRetention');
    const { getCacheRetentionStatus: freshStatus } = await import('../../../../src/host/services/infra/cacheRetentionStatus');

    const toolRoot = path.join(root, 'tool-screenshots');
    const sess = path.join(toolRoot, 'sess-ro');
    const shot = path.join(sess, 'screenshot_1799999999999.png');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(shot, Buffer.alloc(16, 1));
    const at = new Date(NOW - 90 * DAY_MS);
    fs.utimesSync(shot, at, at);
    const dirs: AppCacheDirSpec[] = [{ kind: 'tool-screenshots', root: toolRoot }];

    fs.chmodSync(sess, 0o555); // 删除失败注入：目录只读，unlink 必失败
    try {
      const failedSummary = await freshSweep({ dirs, dbPath, now: NOW });
      expect(failedSummary).toEqual({ deleted: 0, failed: 1, lastError: expect.any(String) });
      expect(fs.existsSync(shot)).toBe(true); // 删不掉才叫删除失败

      const failed = freshStatus();
      expect(failed.failedCurrent).toBeGreaterThanOrEqual(1);
      // 恰为 1：本轮唯一的失败源就是 tool-screenshots 的这一个文件
      expect(failed.failedCurrent).toBe(1);
      expect(failed.lastError).toEqual(expect.any(String));

      fs.chmodSync(sess, 0o755); // 恢复：同一批文件在干净一轮里必须删得掉
      const cleanSummary = await freshSweep({ dirs, dbPath, now: NOW + 1 });
      expect(cleanSummary).toEqual({ deleted: 1, failed: 0 });
      expect(fs.existsSync(shot)).toBe(false);

      const clean = freshStatus();
      expect(clean.failedCurrent).toBe(0);
      expect(clean.lastError).toBeUndefined();
      // 干净一轮 resetFailures：旧账累计一并清零（失败行不再报旧账）
      expect(clean.failedTotal).toBe(0);
    } finally {
      // 干净一轮可能已把空会话目录一并回收：还在才需要恢复权限（afterEach 的 rmSync）
      if (fs.existsSync(sess)) fs.chmodSync(sess, 0o755);
    }
  });
});

describe('cacheRetentionStatus 聚合', () => {
  it('两家 failedCurrent 求和、lastError 取最近一轮带失败的一家，并带 dataDir', async () => {
    await sweepAppCacheRetention({ dirs: appDirs, dbPath: missingDb(), now: NOW });
    await sweepPresentationPreviewRetention({ cacheRoot: previewRoot, dbPath: missingDb(), now: NOW + 5 });
    const merged = getCacheRetentionStatus();
    expect(merged.failedCurrent).toBe(
      getAppCacheRetentionStatus().failedCurrent + getPresentationPreviewRetentionStatus().failedCurrent,
    );
    expect(merged.failedCurrent).toBeGreaterThanOrEqual(2);
    expect(merged.lastError).toBe(getPresentationPreviewRetentionStatus().lastError);
    expect(merged.lastSweepAt).toBe(NOW + 5);
    expect(typeof merged.dataDir).toBe('string');
    expect(merged.dataDir.length).toBeGreaterThan(0);
  });

  it('retryCacheRetentionSweeps 立即重跑并返回新状态（不抛错）', async () => {
    const status = await retryCacheRetentionSweeps();
    expect(status).toMatchObject({ failedCurrent: expect.any(Number), dataDir: expect.any(String) });
  });
});
