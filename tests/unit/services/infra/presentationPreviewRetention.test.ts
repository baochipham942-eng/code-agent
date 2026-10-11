import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESENTATION_PREVIEW_CACHE_DIRNAME } from '../../../../src/host/tools/media/ppt/constants';
import { sweepPresentationPreviewRetention } from '../../../../src/host/services/infra/presentationPreviewRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

// 引用扫描要读的表全部建出来（只含被扫描的列）；缺任何一张都会被当成扫描失败
const SCAN_TABLES_DDL = `
CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, tool_calls TEXT, tool_results TEXT, responses_output TEXT, attachments TEXT, compaction TEXT, metadata TEXT);
CREATE TABLE companion_artifacts (artifact_id TEXT PRIMARY KEY, path TEXT);
CREATE TABLE tool_executions (id TEXT PRIMARY KEY, arguments TEXT, result TEXT);
CREATE TABLE turn_snapshots (id TEXT PRIMARY KEY, context_chunks TEXT);
CREATE TABLE compaction_snapshots (id TEXT PRIMARY KEY, pre_messages_summary TEXT, post_messages_summary TEXT);
CREATE TABLE file_checkpoints (id TEXT PRIMARY KEY, file_path TEXT, original_content TEXT);
CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, result_json TEXT);
CREATE TABLE workflow_run_calls (run_id TEXT, call_index INTEGER, result_json TEXT);
CREATE TABLE session_fork_anchor_evidence (id TEXT PRIMARY KEY, summary_json TEXT, evidence_json TEXT);
`;

interface Fixture {
  root: string;
  cacheRoot: string;
  dbPath: string;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-preview-retention-'));
  const cacheRoot = path.join(root, 'cache', PRESENTATION_PREVIEW_CACHE_DIRNAME);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const dbPath = path.join(root, 'code-agent.db');
  execFileSync('sqlite3', [dbPath, SCAN_TABLES_DDL], { encoding: 'utf-8' });
  return { root, cacheRoot, dbPath };
}

/** 64 位 hex revision 目录名（sha256 输出形状） */
function revHex(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

function insertRow(table: string, columns: string[], values: Array<string | null>): void {
  const cols = columns.join(', ');
  const vals = values.map((value) => (value == null ? 'NULL' : sqlQuote(value))).join(', ');
  execFileSync('sqlite3', [fixture!.dbPath, `INSERT INTO ${table} (${cols}) VALUES (${vals});`], {
    encoding: 'utf-8',
  });
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
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe('presentation preview retention sweep', () => {
  it('删除未引用且超 30 天的 revision 目录；30 天内与 29 天的不动', async () => {
    const old = writeRevisionDir(revHex(1), { filePath: writeDeck('gone-deck.pptx'), lastUsedAt: NOW - 31 * DAY_MS });
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

    insertRow('messages', ['id', 'content'], ['m1', `看图 ${fixture!.cacheRoot}/${revHex(1)}/pages/deck-1.jpg`]);
    insertRow('messages', ['id', 'tool_results'], ['m2', `{"screenshot":"${fixture!.cacheRoot}/${revHex(2)}/pages/deck-1.jpg"}`]);
    insertRow('messages', ['id', 'metadata'], ['m3', `{"preview":"${fixture!.cacheRoot}/${revHex(3)}"}`]);
    insertRow('companion_artifacts', ['artifact_id', 'path'], ['a1', `${fixture!.cacheRoot}/${revHex(4)}/pages/deck-2.jpg`]);
    insertRow('tool_executions', ['id', 'result'], ['t1', `{"path":"${fixture!.cacheRoot}/${revHex(5)}/pages/deck-1.jpg"}`]);

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
    execFileSync('sqlite3', [fixture!.dbPath, 'DROP TABLE workflow_run_calls;'], { encoding: 'utf-8' });
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
