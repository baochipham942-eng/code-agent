// ============================================================================
// toolScreenshotDir — 工具默认截图目录（N-RETENTION-SHOTS-APPDIR）
// 无显式路径的截图改落数据目录（不再写用户工作目录），按会话隔离。
// ============================================================================

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';

import {
  getToolScreenshotDir,
  getToolScreenshotsRoot,
  removeToolScreenshotDir,
} from '../../../../src/host/tools/utils/toolScreenshotDir';
import { TOOL_SCREENSHOTS } from '../../../../src/shared/constants';

const dataDirs: string[] = [];
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tool-screenshot-dir-'));
  dataDirs.push(dataDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  while (dataDirs.length) rmSync(dataDirs.pop()!, { recursive: true, force: true });
});

describe('getToolScreenshotsRoot', () => {
  it('落在 CODE_AGENT_DATA_DIR 下的常量子目录', () => {
    expect(getToolScreenshotsRoot()).toBe(
      path.join(dataDirs[0], 'tool-screenshots'),
    );
    expect(getToolScreenshotsRoot()).toBe(
      path.join(dataDirs[0], TOOL_SCREENSHOTS.DIR_NAME),
    );
  });
});

describe('getToolScreenshotDir', () => {
  it('普通会话 id 得到 <root>/<sessionId>/ 子目录', () => {
    expect(getToolScreenshotDir('sess_ABC-123')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', 'sess_ABC-123'),
    );
  });

  it('未提供 / 空会话 id 落 no-session 兜底目录', () => {
    const fallback = path.join(dataDirs[0], 'tool-screenshots', 'no-session');
    expect(getToolScreenshotDir(undefined)).toBe(fallback);
    expect(getToolScreenshotDir('')).toBe(fallback);
  });

  it('会话 id 带 ../ 时清洗掉分隔符，无法逃出根目录', () => {
    const root = getToolScreenshotsRoot();
    for (const sessionId of ['../evil', '../../etc', '..//..', 'a/../../b', '../../../tmp/x']) {
      const dir = getToolScreenshotDir(sessionId);
      expect(dir.startsWith(root + path.sep)).toBe(true);
      expect(dir).not.toContain('..');
      // 逃逸的对照：如果分隔符没被清洗，路径会跳出 root
      expect(path.relative(root, dir).startsWith('..')).toBe(false);
    }
    // 纯非法字符清洗后为空 → 兜底
    expect(getToolScreenshotDir('../..')).toBe(path.join(root, TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME));
    expect(getToolScreenshotDir('.. . ..')).toBe(path.join(root, TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME));
  });

  it('允许的字符集 [A-Za-z0-9_-] 原样保留，其余字符剔除', () => {
    expect(getToolScreenshotDir('ses.s/i:o*n')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', 'session'),
    );
    expect(getToolScreenshotDir('9f3c2e80-d1a4_7')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', '9f3c2e80-d1a4_7'),
    );
  });
});

// ============================================================================
// removeToolScreenshotDir — 会话删除后的目录回收（N-RETENTION-APP-CACHES-REST1）
// rework r1 起：删前扫全库引用（剔除死者自己的行），只删无活引用的文件——
// 分叉子会话复制了父会话消息里的截图绝对路径，是活引用必须保。
// 删掉 sessionManager 里的调用本组测试仍绿（它们只测本模块）；接线红由
// sessionManagerToolScreenshotCleanup.test.ts 钉住。
// ============================================================================
describe('removeToolScreenshotDir', () => {
  /** 引用扫描要读的库（生产 schema；缺库 = 扫描失败 = 保守全保留） */
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(path.join(dataDirs[0], 'code-agent.db'));
    applyTestSessionSchema(db);
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  /** 造一个带文件的会话截图目录，返回其路径 */
  function makeSessionDir(sessionId: string | undefined): string {
    const dir = getToolScreenshotDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'screenshot_1.png'), 'x');
    return dir;
  }

  /** 落一条引用了 given 文本的会话消息（fork 复制形状：content 带绝对路径） */
  function insertMessageReferencing(sessionId: string, text: string): void {
    db.prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, 'fixture', 'test', 'test', 1, 1);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(`m-${sessionId}-${text.length}`, sessionId, 'assistant', text, 1);
  }

  it('无活引用时整个会话目录（含文件）回收，不动别的会话', async () => {
    const a = makeSessionDir('sess-a');
    const b = makeSessionDir('sess-b');

    await removeToolScreenshotDir('sess-a');

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  });

  it('被其他存活会话引用的文件保留、未引用的删掉；目录因仍有文件而保留', async () => {
    const dir = getToolScreenshotDir('parent-a');
    mkdirSync(dir, { recursive: true });
    const referenced = path.join(dir, 'screenshot_1800000000000.png');
    const stale = path.join(dir, 'screenshot_1800000000001.png');
    writeFileSync(referenced, 'x');
    writeFileSync(stale, 'x');
    // 分叉子会话复制来的父阶段消息（活引用）；父会话自己的引用不算数（被剔除）
    insertMessageReferencing('child-fork', `已保存截图 ${referenced}`);
    insertMessageReferencing('parent-a', `已保存截图 ${stale}`);

    await removeToolScreenshotDir('parent-a');

    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('引用扫描失败（库不存在）时整个目录保守保留', async () => {
    const dir = makeSessionDir('sess-nodb');
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(path.join(dataDirs[0], `code-agent.db${suffix}`), { force: true });
    }

    await removeToolScreenshotDir('sess-nodb');

    expect(existsSync(dir)).toBe(true);
  });

  it('目录不存在（ENOENT）静默成功', async () => {
    await expect(removeToolScreenshotDir('never-existed')).resolves.toBeUndefined();
  });

  it('未提供 / 空会话 id 不动 no-session 共享兜底目录', async () => {
    const fallback = makeSessionDir(undefined);
    await removeToolScreenshotDir(undefined);
    await removeToolScreenshotDir('');
    expect(existsSync(fallback)).toBe(true);
  });

  it('清洗后落入兜底名的非法 id（如 ../..）拒绝动共享兜底目录；显式点名 no-session 才动', async () => {
    const fallback = makeSessionDir('../..');
    await removeToolScreenshotDir('../..');
    expect(existsSync(fallback)).toBe(true);

    await removeToolScreenshotDir(TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME);
    expect(existsSync(fallback)).toBe(false);
  });

  it('其他删除失败（目录只读 EACCES）只 warn 不抛——调用方（会话删除）绝不被拖挂', async () => {
    const dir = makeSessionDir('sess-locked');
    chmodSync(dir, 0o555);
    try {
      await expect(removeToolScreenshotDir('sess-locked')).resolves.toBeUndefined();
      expect(existsSync(dir)).toBe(true);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
