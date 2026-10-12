import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepAppCacheRetention, type AppCacheDirSpec } from '../../../../src/host/services/infra/appCacheRetention';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

interface Fixture {
  root: string;
  channelMediaRoot: string;
  screenshotRoot: string;
  appshotsRoot: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cache-retention-'));
  const channelMediaRoot = path.join(root, 'channel-media');
  const screenshotRoot = path.join(root, 'screenshots');
  const appshotsRoot = path.join(root, 'appshots');
  const dbPath = path.join(root, 'code-agent.db');
  // 引用扫描要读的表全走生产 applySchema；缺任何一张（如 DROP TABLE 用例）都会被当成扫描失败
  const db = new Database(dbPath);
  applyTestSessionSchema(db);
  return { root, channelMediaRoot, screenshotRoot, appshotsRoot, dbPath, db };
}

/** 写一个缓存文件并把 mtime 钉到指定时刻（age 判定只看 mtime） */
function writeFile(filePath: string, options: { ageMs: number; bytes?: number }): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const size = options.bytes ?? 16;
  fs.writeFileSync(filePath, Buffer.alloc(size, 1));
  const at = new Date(NOW - options.ageMs);
  fs.utimesSync(filePath, at, at);
  return filePath;
}

function insertRow(table: string, row: Record<string, string | number | null>): void {
  const columns = Object.keys(row);
  const marks = columns.map(() => '?').join(', ');
  fixture!.db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${marks})`)
    .run(...columns.map((column) => row[column]));
}

/** 落一条引用了 given 文本的会话消息（messages.content 是引用扫描的主源） */
function insertMessageReferencing(text: string): void {
  insertRow('sessions', {
    id: 's1',
    title: 'fixture',
    model_provider: 'test',
    model_name: 'test',
    created_at: NOW,
    updated_at: NOW,
  });
  insertRow('messages', {
    id: 'm1',
    session_id: 's1',
    role: 'user',
    content: text,
    timestamp: NOW,
  });
}

function allDirs(overrides?: Partial<Record<AppCacheDirSpec['kind'], { maxAgeMs?: number; maxTotalBytes?: number }>>): AppCacheDirSpec[] {
  const base: AppCacheDirSpec[] = [
    { kind: 'channel-media', root: fixture!.channelMediaRoot },
    { kind: 'screenshots', root: fixture!.screenshotRoot },
    { kind: 'appshots', root: fixture!.appshotsRoot },
  ];
  if (!overrides) return base;
  return base.map((spec) => ({ ...spec, ...(overrides[spec.kind] ?? {}) }));
}

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  if (fixture) {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixture = undefined;
  delete process.env.CODE_AGENT_DATA_DIR;
});

describe('app cache retention sweep', () => {
  it('超龄未引用的 channel-media 文件回收；59 天/24h 内/被消息引用的不动', async () => {
    const media = (name: string) => path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', name);
    const old = writeFile(media('om_old-file_old.png'), { ageMs: 61 * DAY_MS });
    const almost = writeFile(media('om_edge-file_edge.png'), { ageMs: 59 * DAY_MS });
    const fresh = writeFile(media('om_new-file_new.png'), { ageMs: 12 * HOUR_MS });
    const referenced = writeFile(media('om_ref-file_ref.png'), { ageMs: 61 * DAY_MS });
    insertMessageReferencing(`看图 ${referenced}`);

    const summary = await sweepAppCacheRetention({
      dirs: allDirs(),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(almost)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(referenced)).toBe(true);
  });

  it('消息附件 localPath 与 appshot-<requestId> 文本引用的文件超龄也不删（附件数据落库已剥离，只剩 id/路径文本）', async () => {
    const attachmentPng = writeFile(path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', 'om_att-file_att.png'), { ageMs: 90 * DAY_MS });
    const shotKept = writeFile(path.join(fixture!.appshotsRoot, 'appshot-1799999999999.png'), { ageMs: 120 * DAY_MS });
    const shotStale = writeFile(path.join(fixture!.appshotsRoot, 'appshot-1788888888888.png'), { ageMs: 120 * DAY_MS });
    insertRow('sessions', {
      id: 's1',
      title: 'fixture',
      model_provider: 'test',
      model_name: 'test',
      created_at: NOW,
      updated_at: NOW,
    });
    insertRow('messages', {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: '',
      timestamp: NOW,
      attachments: JSON.stringify([{ id: 'om_att-file_att', localPath: attachmentPng }]),
    });
    insertRow('messages', {
      id: 'm2',
      session_id: 's1',
      role: 'user',
      content: '窗口捕捉见附件 appshot-1799999999999',
      timestamp: NOW,
    });

    const summary = await sweepAppCacheRetention({
      dirs: allDirs(),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(attachmentPng)).toBe(true);
    expect(fs.existsSync(shotKept)).toBe(true);
    expect(fs.existsSync(shotStale)).toBe(false);
  });

  it('引用扫描不可信（库文件缺失/表缺失）时，三个目录一个文件都不删，恰好记 1 次失败', async () => {
    const oldMedia = writeFile(path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', 'om_a-file_a.png'), { ageMs: 90 * DAY_MS });
    const oldShot = writeFile(path.join(fixture!.screenshotRoot, 'screenshot_1.png'), { ageMs: 90 * DAY_MS });
    const oldAppshot = writeFile(path.join(fixture!.appshotsRoot, 'appshot-1.png'), { ageMs: 120 * DAY_MS });

    const missingDb = await sweepAppCacheRetention({
      dirs: allDirs(),
      dbPath: path.join(fixture!.root, 'no-such.db'),
      now: NOW,
    });
    expect(missingDb).toEqual({ deleted: 0, failed: 1, lastError: expect.any(String) });
    expect(fs.existsSync(oldMedia)).toBe(true);
    expect(fs.existsSync(oldShot)).toBe(true);
    expect(fs.existsSync(oldAppshot)).toBe(true);

    // 再验表缺失：拆掉一张扫描表后重扫，同样一个不删
    fixture!.db.exec('DROP TABLE workflow_run_calls;');
    const missingTable = await sweepAppCacheRetention({
      dirs: allDirs(),
      dbPath: fixture!.dbPath,
      now: NOW,
    });
    expect(missingTable).toEqual({ deleted: 0, failed: 1, lastError: expect.any(String) });
    expect(fs.existsSync(oldMedia)).toBe(true);
    expect(fs.existsSync(oldShot)).toBe(true);
    expect(fs.existsSync(oldAppshot)).toBe(true);
  });

  it('截图目录只把 *.png 当候选：storage_state_*.json 与其他扩展名即使超龄+超量也永不触碰', async () => {
    const storageState = writeFile(path.join(fixture!.screenshotRoot, 'storage_state_1800000000000.json'), { ageMs: 100 * DAY_MS, bytes: 10 });
    const note = writeFile(path.join(fixture!.screenshotRoot, 'notes.txt'), { ageMs: 100 * DAY_MS, bytes: 10 });
    const oldPng = writeFile(path.join(fixture!.screenshotRoot, 'screenshot_1.png'), { ageMs: 100 * DAY_MS, bytes: 10 });
    const freshPng = writeFile(path.join(fixture!.screenshotRoot, 'screenshot_2.png'), { ageMs: 12 * HOUR_MS, bytes: 10 });

    const summary = await sweepAppCacheRetention({
      // cap 压到 1 字节：删完 png 后目录仍超量，但非候选/过地板的都不能动
      dirs: allDirs({ screenshots: { maxTotalBytes: 1 } }),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(oldPng)).toBe(false);
    expect(fs.existsSync(storageState)).toBe(true);
    expect(fs.existsSync(note)).toBe(true);
    expect(fs.existsSync(freshPng)).toBe(true);
  });

  it('目录超总量上限时从未引用的最旧文件删起；被引用与 24h 内的文件即使超量也保留', async () => {
    const media = (name: string) => path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', name);
    const oldest = writeFile(media('om_1-file_1.png'), { ageMs: 40 * DAY_MS, bytes: 100 });
    const newer = writeFile(media('om_2-file_2.png'), { ageMs: 39 * DAY_MS, bytes: 100 });
    const referenced = writeFile(media('om_3-file_3.png'), { ageMs: 38 * DAY_MS, bytes: 100 });
    const young = writeFile(media('om_4-file_4.png'), { ageMs: 12 * HOUR_MS, bytes: 100 });
    insertMessageReferencing(`历史消息 ${referenced}`);

    // 40 天 < 60 天保留期：年龄路径一个不删，全靠超量路径；cap=250 时删最旧的
    // oldest(100) + newer(100) 后总量 200 ≤ 250 停，referenced/young 不在其列
    const summary = await sweepAppCacheRetention({
      dirs: allDirs({ 'channel-media': { maxTotalBytes: 250 } }),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 2, failed: 0 });
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(newer)).toBe(false);
    expect(fs.existsSync(referenced)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
  });

  it('Windows 反斜杠形状的引用（raw 路径与 JSON 转义）经分隔符归一也算被引用', async () => {
    const keptRaw = writeFile(path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', 'om_win-file_win.png'), { ageMs: 90 * DAY_MS });
    const keptJson = writeFile(path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', 'om_esc-file_esc.png'), { ageMs: 90 * DAY_MS });
    const stale = writeFile(path.join(fixture!.channelMediaRoot, 'feishu', 'acc1', 'om_stale-file_stale.png'), { ageMs: 90 * DAY_MS });
    const winRoot = `C:\\Users\\dev\\.code-agent\\cache\\channel-media`;
    insertRow('sessions', {
      id: 's1',
      title: 'fixture',
      model_provider: 'test',
      model_name: 'test',
      created_at: NOW,
      updated_at: NOW,
    });
    insertRow('messages', {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: '',
      timestamp: NOW,
      tool_results: `${winRoot}\\feishu\\acc1\\om_win-file_win.png`,
    });
    insertRow('messages', {
      id: 'm2',
      session_id: 's1',
      role: 'user',
      content: '',
      timestamp: NOW,
      metadata: JSON.stringify({ path: `${winRoot}\\feishu\\acc1\\om_esc-file_esc.png` }),
    });

    const summary = await sweepAppCacheRetention({
      dirs: allDirs(),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(keptRaw)).toBe(true);
    expect(fs.existsSync(keptJson)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('symlink 与目录不是候选：symlink 即使超龄+超量也不删，子目录正常下钻', async () => {
    const target = path.join(fixture!.root, 'outside.png');
    fs.writeFileSync(target, 'x');
    const link = path.join(fixture!.screenshotRoot, 'linked.png');
    fs.mkdirSync(fixture!.screenshotRoot, { recursive: true });
    fs.symlinkSync(target, link);
    const nested = writeFile(path.join(fixture!.channelMediaRoot, 'lark', 'acc2', 'deep', 'om_n-file_n.png'), { ageMs: 90 * DAY_MS });

    // 截图目录 cap 压到 1 字节：目录保持超量，symlink 仍必须不是候选
    const summary = await sweepAppCacheRetention({
      dirs: allDirs({ screenshots: { maxTotalBytes: 1 } }),
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(fs.existsSync(link)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(nested)).toBe(false);
    expect(summary.deleted).toBe(1);
  });

  it('根目录不存在时静默跳过（不算失败）', async () => {
    const summary = await sweepAppCacheRetention({
      dirs: [{ kind: 'channel-media', root: path.join(fixture!.root, 'no-such-dir') }],
      dbPath: fixture!.dbPath,
      now: NOW,
    });
    expect(summary).toEqual({ deleted: 0, failed: 0 });
  });
});

describe('app cache retention 写入点覆盖（缺省根 = 写入方根）', () => {
  it('三个写入点的目录常量/函数都被 sweep 的缺省根覆盖（CODE_AGENT_DATA_DIR 通道）', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cache-defaults-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    // 防呆：sweep 前先证明 fresh 模块的 data-dir 解析已指到 tmp——
    // 这条断言不绿就绝不往下扫，避免误扫真实用户目录
    vi.resetModules();
    const { sweepAppCacheRetention: freshSweep } = await import('../../../../src/host/services/infra/appCacheRetention');
    const { getUserDataPath } = await import('../../../../src/host/platform/appPaths');
    const { defaultChannelMediaCacheRoot, CHANNEL_MEDIA_CACHE_DIRNAME } = await import('../../../../src/host/channels/feishu/feishuMedia');
    const { MANAGED_BROWSER_ARTIFACT_DIR } = await import('../../../../src/host/services/infra/browser/managedBrowserHelpers');
    expect(getUserDataPath()).toBe(dataDir);

    // 写入点 1：feishuMedia.buildCacheDir 的缺省根
    const channelMediaRoot = defaultChannelMediaCacheRoot();
    expect(channelMediaRoot).toBe(path.join(dataDir, 'cache', CHANNEL_MEDIA_CACHE_DIRNAME));
    // 写入点 2：browserService ctor 的 app.getPath('userData') + MANAGED_BROWSER_ARTIFACT_DIR
    expect(path.join(getUserDataPath(), MANAGED_BROWSER_ARTIFACT_DIR)).toBe(path.join(dataDir, 'screenshots'));
    // 写入点 3：Rust appshots_dir() 的目录名/文件名形状（Node 不改 Rust，只对齐）
    const appshotsRs = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/appshots.rs'), 'utf8');
    expect(appshotsRs).toContain('.join("appshots")');
    expect(appshotsRs).toContain('format!("appshot-{}", now_ms())');

    // 三个缺省根各放一个超龄未引用文件：不传 dirs 走缺省根，应各删一个
    const dbPath = path.join(dataDir, 'code-agent.db');
    const db = new Database(dbPath);
    applyTestSessionSchema(db);
    try {
      const markers = [
        writeFile(path.join(channelMediaRoot, 'feishu', 'acc1', 'om_c-file_c.png'), { ageMs: 90 * DAY_MS }),
        writeFile(path.join(dataDir, 'screenshots', 'screenshot_cover.png'), { ageMs: 90 * DAY_MS }),
        writeFile(path.join(dataDir, 'appshots', 'appshot-1777777777777.png'), { ageMs: 120 * DAY_MS }),
      ];
      const summary = await freshSweep({ dbPath, now: NOW });
      expect(summary).toEqual({ deleted: 3, failed: 0 });
      expect(markers.map((marker) => fs.existsSync(marker))).toEqual([false, false, false]);
    } finally {
      db.close();
    }
  });
});
