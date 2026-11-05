// ============================================================================
// PR #2820 review 反向钉：sweep/clear 的 wav_path 指针清空必须批量。
//
// 逐行 clearPointer 的版本每条过期行 spawn 一次 sqlite3（~15ms），
// 采集长期关闭、backlog 几千行的机器首次启动时，这笔 O(rows) 的同步阻塞
// 全记在 server.listen 之前的启动时间里。这里用「子进程调用数不随行数涨」
// 把根因钉死：夹具 40 行过期，逐行版 spawn 40+ 次（红），批量版 ≤4（绿）。
// ============================================================================

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllAudioRecordings,
  sweepAudioRetention,
} from '../../../../src/host/services/desktop/audioRetention';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  sqlite3SpawnCount: 0,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

// 透传式计数：只数 sqlite3 调用次数，行为不变（importActual 骨架，拦截 named import）
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  const realExecFileSync = actual.execFileSync;
  return {
    ...actual,
    execFileSync: ((command: string, args: unknown[], options: unknown) => {
      if (command === 'sqlite3') mocks.sqlite3SpawnCount += 1;
      return realExecFileSync(command, args as Parameters<typeof realExecFileSync>[1], options as Parameters<typeof realExecFileSync>[2]);
    }) as typeof realExecFileSync,
  };
});

const EXPIRED_AGE_MS = 25 * 60 * 60 * 1000;

const AUDIO_SEGMENTS_DDL = `
CREATE TABLE IF NOT EXISTS audio_segments (
  id TEXT PRIMARY KEY,
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  wav_path TEXT,
  transcript TEXT,
  speaker_id INTEGER DEFAULT 0,
  asr_engine TEXT,
  asr_duration_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_start ON audio_segments (start_at_ms DESC);
`;

const EXPIRED_ROWS = 40;
// 允许的 sqlite3 调用上限：loadRows 1 + 批量清指针 ≤2 块（40 行 < 200/块 → 1 块）。
// 逐行版 = 1 + 40 = 41，远超此界 → 红。
const SPAWN_BUDGET = 4;

interface Fixture {
  root: string;
  audioDir: string;
  sqlitePath: string;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-retention-batch-'));
  const audioDir = path.join(root, 'audio');
  fs.mkdirSync(audioDir);
  const sqlitePath = path.join(root, 'segments.sqlite');
  execFileSync('sqlite3', [sqlitePath, AUDIO_SEGMENTS_DDL], { encoding: 'utf-8' });
  return { root, audioDir, sqlitePath };
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function seedExpiredAndKeptRows(count: number): { expired: string[]; kept: string } {
  const expired: string[] = [];
  const statements: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(fixture!.audioDir, '2026-11-01');
    fs.mkdirSync(dir, { recursive: true });
    const wavPath = path.join(dir, `expired_${i}.wav`);
    fs.writeFileSync(wavPath, 'RIFF-fixture');
    const stale = new Date(Date.now() - EXPIRED_AGE_MS);
    fs.utimesSync(wavPath, stale, stale);
    expired.push(wavPath);
    statements.push(
      `INSERT INTO audio_segments (id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, asr_engine, asr_duration_ms, created_at_ms) VALUES (${sqlQuote(`seg-${i}`)}, 0, 0, 0, ${sqlQuote(wavPath)}, NULL, 'none', 0, ${Date.now() - EXPIRED_AGE_MS});`,
    );
  }
  const keptDir = path.join(fixture!.audioDir, '2026-11-04');
  fs.mkdirSync(keptDir, { recursive: true });
  const kept = path.join(keptDir, 'kept.wav');
  fs.writeFileSync(kept, 'RIFF-fixture');
  statements.push(
    `INSERT INTO audio_segments (id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, asr_engine, asr_duration_ms, created_at_ms) VALUES ('seg-kept', 0, 0, 0, ${sqlQuote(kept)}, NULL, 'none', 0, ${Date.now() - 60 * 60 * 1000});`,
  );
  execFileSync('sqlite3', [fixture!.sqlitePath, statements.join('')], { encoding: 'utf-8' });
  return { expired, kept };
}

function readWavPaths(sqlitePath: string): Map<string, string | null> {
  const output = execFileSync(
    'sqlite3',
    ['-json', sqlitePath, 'SELECT id, wav_path FROM audio_segments;'],
    { encoding: 'utf-8' },
  ).trim();
  const rows = JSON.parse(output) as Array<{ id: string; wav_path: string | null }>;
  return new Map(rows.map((row) => [row.id, row.wav_path]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sqlite3SpawnCount = 0;
  fixture = makeFixture();
});

afterEach(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe('清扫/清空的 sqlite3 子进程数与过期行数解耦', () => {
  it(`sweep：${EXPIRED_ROWS} 条过期行的指针清空不逐行 spawn（≤${SPAWN_BUDGET} 次）`, () => {
    const { kept } = seedExpiredAndKeptRows(EXPIRED_ROWS);
    // 计数只针对被测的清扫本身：夹具种入（DDL/INSERT）也走包装过的 execFileSync
    mocks.sqlite3SpawnCount = 0;

    const summary = sweepAudioRetention({
      sqlitePath: fixture!.sqlitePath,
      audioDir: fixture!.audioDir,
      now: Date.now(),
    });

    // 行为不回退：过期全删、指针全清、保留期内原样
    expect(summary.deleted).toBe(EXPIRED_ROWS);
    expect(summary.rowsUpdated).toBe(EXPIRED_ROWS);
    const rows = readWavPaths(fixture!.sqlitePath);
    for (let i = 0; i < EXPIRED_ROWS; i += 1) expect(rows.get(`seg-${i}`)).toBeNull();
    expect(rows.get('seg-kept')).toBe(kept);
    expect(fs.existsSync(kept)).toBe(true);
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    // 根因钉子：sqlite3 调用数不随行数线性涨（逐行版这里是 41）
    expect(mocks.sqlite3SpawnCount).toBeLessThanOrEqual(SPAWN_BUDGET);
  });

  it(`clearAll：${EXPIRED_ROWS} 行的清空同样不逐行 spawn（≤${SPAWN_BUDGET} 次）`, () => {
    const { kept } = seedExpiredAndKeptRows(EXPIRED_ROWS);
    mocks.sqlite3SpawnCount = 0;

    const result = clearAllAudioRecordings({
      sqlitePath: fixture!.sqlitePath,
      audioDir: fixture!.audioDir,
    });

    expect(result.deleted).toBe(EXPIRED_ROWS + 1);
    expect(fs.existsSync(kept)).toBe(false);
    const rows = readWavPaths(fixture!.sqlitePath);
    expect(rows.get('seg-kept')).toBeNull();
    for (let i = 0; i < EXPIRED_ROWS; i += 1) expect(rows.get(`seg-${i}`)).toBeNull();

    expect(mocks.sqlite3SpawnCount).toBeLessThanOrEqual(SPAWN_BUDGET);
  });

  it('分块跨块也全清：205 行跨过 200/块的边界，两块 UPDATE 清光所有指针', () => {
    const { expired } = seedExpiredAndKeptRows(205);
    mocks.sqlite3SpawnCount = 0;

    const summary = sweepAudioRetention({
      sqlitePath: fixture!.sqlitePath,
      audioDir: fixture!.audioDir,
      now: Date.now(),
    });

    expect(summary.deleted).toBe(205);
    expect(summary.rowsUpdated).toBe(205);
    // loadRows 1 + 两块 UPDATE 2 = 3（断言须在 readWavPaths 之前：它自己也 spawn 一次）
    expect(mocks.sqlite3SpawnCount).toBe(3);
    for (const wavPath of expired) expect(fs.existsSync(wavPath)).toBe(false);
    const rows = readWavPaths(fixture!.sqlitePath);
    for (let i = 0; i < 205; i += 1) expect(rows.get(`seg-${i}`)).toBeNull();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('没有待清指针时不额外 spawn', () => {
    seedExpiredAndKeptRows(0);
    mocks.sqlite3SpawnCount = 0;

    const summary = sweepAudioRetention({
      sqlitePath: fixture!.sqlitePath,
      audioDir: fixture!.audioDir,
      now: Date.now(),
    });

    expect(summary).toEqual({ deleted: 0, failed: 0, rowsUpdated: 0 });
    expect(mocks.sqlite3SpawnCount).toBe(1); // 仅 loadRows
  });
});
