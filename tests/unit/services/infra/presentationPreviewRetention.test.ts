import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENTATION_PREVIEW_CACHE_DIRNAME } from '../../../../src/host/tools/media/ppt/constants';
import { sweepPresentationPreviewRetention } from '../../../../src/host/services/infra/presentationPreviewRetention';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  root: string;
  cacheRoot: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-preview-retention-'));
  const cacheRoot = path.join(root, 'cache', PRESENTATION_PREVIEW_CACHE_DIRNAME);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const dbPath = path.join(root, 'code-agent.db');
  // 引用扫描要读的表全走生产 applySchema（messages DDL 不手抄，见 messagesSchemaFixtureGate）；
  // 缺任何一张（如下面的 DROP TABLE 用例）都会被当成扫描失败
  const db = new Database(dbPath);
  applyTestSessionSchema(db);
  return { root, cacheRoot, dbPath, db };
}

/** 64 位 hex revision 目录名（sha256 输出形状） */
function revHex(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 插一行：生产 schema 的 NOT NULL 列由调用方给齐（约束是真的，不给会插不进） */
function insertRow(table: string, row: Record<string, string | number | null>): void {
  const columns = Object.keys(row);
  const marks = columns.map(() => '?').join(', ');
  fixture!.db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${marks})`)
    .run(...columns.map((column) => row[column]));
}

interface RevisionInput {
  filePath?: string;
  lastUsedAt?: number;
  pages?: number;
}

/** 落一个 revision 目录：manifest.json + pages/*.jpg */
function writeRevisionDir(revision: string, input: RevisionInput = {}): string {
  const dirPath = path.join(fixture!.cacheRoot, revision);
  const pagesDir = path.join(dirPath, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const pageCount = input.pages ?? 2;
  const screenshots: string[] = [];
  for (let index = 1; index <= pageCount; index += 1) {
    const screenshot = path.join(pagesDir, `deck-${index}.jpg`);
    fs.writeFileSync(screenshot, 'image');
    screenshots.push(screenshot);
  }
  const manifest: Record<string, unknown> = { revision, screenshots };
  if (input.filePath !== undefined) manifest.filePath = input.filePath;
  if (input.lastUsedAt !== undefined) manifest.lastUsedAt = input.lastUsedAt;
  fs.writeFileSync(path.join(dirPath, 'manifest.json'), JSON.stringify(manifest));
  return dirPath;
}

function writeDeck(name: string): string {
  const deckPath = path.join(fixture!.root, name);
  fs.writeFileSync(deckPath, `pptx-bytes-${name}`);
  return deckPath;
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  if (fixture) {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixture = undefined;
});

describe('presentation preview retention sweep', () => {
  it('删除未引用且超 30 天的 revision 目录；30 天内与 29 天的不动', async () => {
    const old = writeRevisionDir(revHex(1), { filePath: writeDeck('stale.pptx'), lastUsedAt: NOW - 31 * DAY_MS });
    const fresh = writeRevisionDir(revHex(2), { filePath: writeDeck('fresh.pptx'), lastUsedAt: NOW - DAY_MS });
    const almost = writeRevisionDir(revHex(3), { filePath: writeDeck('almost.pptx'), lastUsedAt: NOW - 29 * DAY_MS });

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(almost)).toBe(true);
  });

  it('会话消息与产物账本里仍被引用的目录不删（content/tool_results/metadata/companion_artifacts.path/tool_executions.result 都要扫到）', async () => {
    const deck = writeDeck('referenced.pptx');
    const viaContent = writeRevisionDir(revHex(1), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });
    const viaToolResults = writeRevisionDir(revHex(2), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });
    const viaMetadata = writeRevisionDir(revHex(3), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });
    const viaCompanion = writeRevisionDir(revHex(4), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });
    const viaToolExecutions = writeRevisionDir(revHex(5), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });
    const unreferenced = writeRevisionDir(revHex(6), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });

    // better-sqlite3 默认开 FK：messages/tool_executions 都引用 sessions(id)，先落一条真 session
    insertRow('sessions', {
      id: 's1',
      title: 'fixture',
      model_provider: 'test',
      model_name: 'test',
      created_at: NOW,
      updated_at: NOW,
    });
    // messages 的 session_id/role/content/timestamp 是生产 schema 的 NOT NULL 列
    insertRow('messages', {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: `看图 ${fixture!.cacheRoot}/${revHex(1)}/pages/deck-1.jpg`,
      timestamp: NOW,
    });
    insertRow('messages', {
      id: 'm2',
      session_id: 's1',
      role: 'user',
      content: '',
      timestamp: NOW,
      tool_results: `{"screenshot":"${fixture!.cacheRoot}/${revHex(2)}/pages/deck-1.jpg"}`,
    });
    insertRow('messages', {
      id: 'm3',
      session_id: 's1',
      role: 'user',
      content: '',
      timestamp: NOW,
      metadata: `{"preview":"${fixture!.cacheRoot}/${revHex(3)}"}`,
    });
    insertRow('companion_artifacts', {
      artifact_id: 'a1',
      session_id: 's1',
      version: 1,
      name: 'deck',
      mime_type: 'image/jpeg',
      size: 5,
      sha256: 'x',
      origin: 'test',
      created_at: NOW,
      path: `${fixture!.cacheRoot}/${revHex(4)}/pages/deck-2.jpg`,
    });
    insertRow('tool_executions', {
      id: 't1',
      session_id: 's1',
      tool_name: 'preview',
      arguments: '{}',
      arguments_hash: 'h',
      success: 1,
      duration: 1,
      created_at: NOW,
      result: `{"path":"${fixture!.cacheRoot}/${revHex(5)}/pages/deck-1.jpg"}`,
    });

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(viaContent)).toBe(true);
    expect(fs.existsSync(viaToolResults)).toBe(true);
    expect(fs.existsSync(viaMetadata)).toBe(true);
    expect(fs.existsSync(viaCompanion)).toBe(true);
    expect(fs.existsSync(viaToolExecutions)).toBe(true);
    expect(fs.existsSync(unreferenced)).toBe(false);
  });

  it('扫描读不全（库文件缺失 / 表缺失）本轮一个不删，恰好记 1 次失败', async () => {
    const deck = writeDeck('scan-fail.pptx');
    const old = writeRevisionDir(revHex(1), { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });

    const missingDb = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: path.join(fixture!.root, 'no-such.db'),
      now: NOW,
    });
    expect(missingDb).toEqual({ deleted: 0, failed: 1, lastError: expect.any(String) });
    expect(fs.existsSync(old)).toBe(true);

    // 再验表缺失：拆掉一张扫描表后重扫，同样一个不删
    fixture!.db.exec('DROP TABLE workflow_run_calls;');
    const missingTable = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });
    expect(missingTable).toEqual({ deleted: 0, failed: 1, lastError: expect.any(String) });
    expect(fs.existsSync(old)).toBe(true);
  });

  it('deck 现行 revision（重算 sha256 一致）超 30 天也不删', async () => {
    const deck = writeDeck('current.pptx');
    const currentRevision = sha256File(deck);
    const currentDir = writeRevisionDir(currentRevision, { filePath: deck, lastUsedAt: NOW - 40 * DAY_MS });

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(currentDir)).toBe(true);
  });

  it('deck 文件已不存在（ENOENT）：超 30 天回收、30 天内不动；deck 路径读不出（EISDIR）保守保留', async () => {
    // manifest 指向的 pptx 已被删/挪走 → 无现行 revision 可保护，按年龄正常判定
    const missingDeck = path.join(fixture!.root, 'no-such-deck.pptx');
    const staleMissing = writeRevisionDir(revHex(1), { filePath: missingDeck, lastUsedAt: NOW - 40 * DAY_MS });
    const freshMissing = writeRevisionDir(revHex(2), { filePath: missingDeck, lastUsedAt: NOW - DAY_MS });
    // 路径被目录占住：算不出 sha256 但文件系统有东西 → 保守保留
    const dirDeck = path.join(fixture!.root, 'dir-deck.pptx');
    fs.mkdirSync(dirDeck);
    const unreadable = writeRevisionDir(revHex(3), { filePath: dirDeck, lastUsedAt: NOW - 40 * DAY_MS });

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(staleMissing)).toBe(false);
    expect(fs.existsSync(freshMissing)).toBe(true);
    expect(fs.existsSync(unreadable)).toBe(true);
  });

  it('同 deck 保留最新 3 个；超出且超 7 天的回收，超出但未超 7 天的不动', async () => {
    // deck 已被改写（文件 sha 不等于任何缓存 revision）→ 无现行 revision 保护
    const deck = writeDeck('edited.pptx');
    fs.writeFileSync(deck, 'edited-again');
    const ages = [1, 2, 3, 5, 8, 40];
    const dirs = ages.map((ageDays, index) => writeRevisionDir(revHex(index + 1), {
      filePath: deck,
      lastUsedAt: NOW - ageDays * DAY_MS,
    }));

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    // 排序后（新→旧）：1d/2d/3d 受 3 个保留名额保护；5d 超名额但未到 7 天；8d 与 40d 回收
    expect(summary).toEqual({ deleted: 2, failed: 0 });
    expect(dirs.map((dir) => fs.existsSync(dir))).toEqual([true, true, true, true, false, false]);
  });

  it('没有 filePath 的旧 manifest、读不出的 manifest、非 revision 命名的目录一律不动', async () => {
    const legacy = path.join(fixture!.cacheRoot, revHex(1));
    fs.mkdirSync(path.join(legacy, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({
      revision: revHex(1),
      screenshots: [path.join(legacy, 'pages', 'deck-1.jpg')],
    }));

    const noManifest = path.join(fixture!.cacheRoot, revHex(2));
    fs.mkdirSync(path.join(noManifest, 'pages'), { recursive: true });

    const foreign = path.join(fixture!.cacheRoot, 'not-a-revision');
    fs.mkdirSync(path.join(foreign, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'manifest.json'), JSON.stringify({
      revision: 'not-a-revision',
      filePath: writeDeck('foreign.pptx'),
      lastUsedAt: NOW - 90 * DAY_MS,
    }));

    const summary = await sweepPresentationPreviewRetention({
      cacheRoot: fixture!.cacheRoot,
      dbPath: fixture!.dbPath,
      now: NOW,
    });

    expect(summary).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(noManifest)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});
