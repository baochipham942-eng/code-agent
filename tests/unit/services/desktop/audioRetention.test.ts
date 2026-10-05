import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeSegmentAudio,
  sweepAudioRetention,
} from '../../../../src/host/services/desktop/audioRetention';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

interface Fixture {
  root: string;
  audioDir: string;
  sqlitePath: string;
}

interface StoredSegment {
  wavPath: string | null;
  transcript: string | null;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-retention-'));
  const audioDir = path.join(root, 'audio');
  fs.mkdirSync(audioDir);
  const sqlitePath = path.join(root, 'segments.sqlite');
  execFileSync('sqlite3', [sqlitePath, AUDIO_SEGMENTS_DDL], { encoding: 'utf-8' });
  return { root, audioDir, sqlitePath };
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function insertSegment(
  sqlitePath: string,
  row: { id: string; wavPath: string; transcript: string | null; createdAtMs: number },
): void {
  const transcriptSql = row.transcript == null ? 'NULL' : sqlQuote(row.transcript);
  const sql = `INSERT INTO audio_segments (id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, asr_engine, asr_duration_ms, created_at_ms) VALUES (${sqlQuote(row.id)}, 0, 0, 0, ${sqlQuote(row.wavPath)}, ${transcriptSql}, 'none', 0, ${row.createdAtMs});`;
  execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSegment(sqlitePath: string, id: string): StoredSegment {
  const output = execFileSync(
    'sqlite3',
    ['-json', sqlitePath, `SELECT wav_path, transcript FROM audio_segments WHERE id = ${sqlQuote(id)};`],
    { encoding: 'utf-8' },
  ).trim();
  const parsed: unknown = output ? JSON.parse(output) : [];
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
    throw new Error(`missing audio_segments row ${id}`);
  }
  const wavPath = parsed[0].wav_path;
  const transcript = parsed[0].transcript;
  return {
    wavPath: typeof wavPath === 'string' ? wavPath : null,
    transcript: typeof transcript === 'string' ? transcript : null,
  };
}

function danglingWavCount(sqlitePath: string): number {
  const output = execFileSync(
    'sqlite3',
    ['-json', sqlitePath, 'SELECT wav_path FROM audio_segments WHERE wav_path IS NOT NULL;'],
    { encoding: 'utf-8' },
  ).trim();
  const parsed: unknown = output ? JSON.parse(output) : [];
  if (!Array.isArray(parsed)) return -1;
  let missing = 0;
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.wav_path !== 'string') continue;
    if (!fs.existsSync(item.wav_path)) missing += 1;
  }
  return missing;
}

function writeWav(audioDir: string, day: string, name: string): string {
  const dir = path.join(audioDir, day);
  fs.mkdirSync(dir, { recursive: true });
  const wavPath = path.join(dir, name);
  fs.writeFileSync(wavPath, 'RIFF');
  return wavPath;
}

function setMtime(filePath: string, ms: number): void {
  const at = new Date(ms);
  fs.utimesSync(filePath, at, at);
}

function writeBlockedWavDir(audioDir: string): string {
  const blocked = path.join(audioDir, '2026-09-15', 'audio_blocked.wav');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'keep.txt'), 'keep');
  return blocked;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture = makeFixture();
});

afterEach(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe('audio retention', () => {
  it('deletes the wav and nulls wav_path after a successful transcript is stored', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const wavPath = writeWav(current.audioDir, '2026-09-30', 'audio_1.wav');
    const now = 1_800_000_000_000;
    insertSegment(current.sqlitePath, {
      id: 'audio-1',
      wavPath,
      transcript: "it's done",
      createdAtMs: now,
    });

    finalizeSegmentAudio({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      segmentId: 'audio-1',
      wavPath,
    });

    expect(fs.existsSync(wavPath)).toBe(false);
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-30'))).toBe(false);
    expect(fs.existsSync(current.audioDir)).toBe(true);
    expect(readSegment(current.sqlitePath, 'audio-1')).toEqual({
      wavPath: null,
      transcript: "it's done",
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });

  it('keeps a failed-transcription wav younger than 24h and deletes it after 24h', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const youngWav = writeWav(current.audioDir, '2026-09-30', 'audio_young.wav');
    const exactWav = writeWav(current.audioDir, '2026-09-29', 'audio_exact.wav');
    const oldWav = writeWav(current.audioDir, '2026-09-28', 'audio_old.wav');
    // Row age decides failed captures. An old mtime must not expire a young row.
    setMtime(youngWav, now - 25 * HOUR_MS);
    insertSegment(current.sqlitePath, {
      id: 'young',
      wavPath: youngWav,
      transcript: null,
      createdAtMs: now - DAY_MS + 60_000,
    });
    insertSegment(current.sqlitePath, {
      id: 'exact',
      wavPath: exactWav,
      transcript: '',
      createdAtMs: now - DAY_MS,
    });
    insertSegment(current.sqlitePath, {
      id: 'old',
      wavPath: oldWav,
      transcript: null,
      createdAtMs: now - DAY_MS - 60_000,
    });

    const summary = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    });

    expect(summary).toEqual({ deleted: 2, failed: 0, rowsUpdated: 2 });
    expect(fs.existsSync(youngWav)).toBe(true);
    expect(readSegment(current.sqlitePath, 'young')).toEqual({ wavPath: youngWav, transcript: null });
    expect(fs.existsSync(exactWav)).toBe(false);
    expect(readSegment(current.sqlitePath, 'exact')).toEqual({ wavPath: null, transcript: '' });
    expect(fs.existsSync(oldWav)).toBe(false);
    expect(readSegment(current.sqlitePath, 'old')).toEqual({ wavPath: null, transcript: null });
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-30'))).toBe(true);
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-29'))).toBe(false);
    expect(danglingWavCount(current.sqlitePath)).toBe(0);

    const sooner = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
      failedRetentionMs: HOUR_MS,
    });
    expect(sooner).toEqual({ deleted: 1, failed: 0, rowsUpdated: 1 });
    expect(fs.existsSync(youngWav)).toBe(false);
    expect(readSegment(current.sqlitePath, 'young').wavPath).toBeNull();
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });

  it('cleans a transcribed wav left behind by a crash on the next sweep', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const wavPath = writeWav(current.audioDir, '2026-09-30', 'audio_crash.wav');
    setMtime(wavPath, now);
    insertSegment(current.sqlitePath, {
      id: 'crash',
      wavPath,
      transcript: 'still here',
      createdAtMs: now,
    });

    const summary = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    });

    expect(summary).toEqual({ deleted: 1, failed: 0, rowsUpdated: 1 });
    expect(fs.existsSync(wavPath)).toBe(false);
    expect(readSegment(current.sqlitePath, 'crash')).toEqual({
      wavPath: null,
      transcript: 'still here',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });

  it('leaves no row whose wav_path points at a missing file', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;

    const successWav = writeWav(current.audioDir, '2026-09-30', 'audio_ok.wav');
    insertSegment(current.sqlitePath, {
      id: 'ok',
      wavPath: successWav,
      transcript: 'hello',
      createdAtMs: now,
    });
    finalizeSegmentAudio({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      segmentId: 'ok',
      wavPath: successWav,
    });
    expect(danglingWavCount(current.sqlitePath)).toBe(0);

    const youngWav = writeWav(current.audioDir, '2026-09-29', 'audio_young.wav');
    const oldWav = writeWav(current.audioDir, '2026-09-28', 'audio_old.wav');
    const crashWav = writeWav(current.audioDir, '2026-09-27', 'audio_crash.wav');
    const missingWav = path.join(current.audioDir, '2026-09-26', 'audio_missing.wav');
    const blocked = writeBlockedWavDir(current.audioDir);
    const outside = `${current.audioDir}/../outside.wav`;
    fs.writeFileSync(path.join(current.root, 'outside.wav'), 'safe');
    const orphanOld = writeWav(current.audioDir, '2026-08-01', 'audio_orphan_old.wav');
    const orphanYoung = writeWav(current.audioDir, '2026-08-02', 'audio_orphan_young.wav');
    setMtime(orphanOld, now - 25 * HOUR_MS);
    setMtime(orphanYoung, now - 23 * HOUR_MS);

    insertSegment(current.sqlitePath, {
      id: 'young',
      wavPath: youngWav,
      transcript: null,
      createdAtMs: now - DAY_MS + 60_000,
    });
    insertSegment(current.sqlitePath, {
      id: 'old',
      wavPath: oldWav,
      transcript: '',
      createdAtMs: now - DAY_MS - 60_000,
    });
    insertSegment(current.sqlitePath, {
      id: 'crash',
      wavPath: crashWav,
      transcript: 'crash',
      createdAtMs: now,
    });
    insertSegment(current.sqlitePath, {
      id: 'missing',
      wavPath: missingWav,
      transcript: null,
      createdAtMs: now,
    });
    insertSegment(current.sqlitePath, {
      id: 'blocked',
      wavPath: blocked,
      transcript: 'blocked',
      createdAtMs: now,
    });
    insertSegment(current.sqlitePath, {
      id: 'outside',
      wavPath: outside,
      transcript: 'nope',
      createdAtMs: now - DAY_MS - 60_000,
    });

    expect(() => sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    })).not.toThrow();

    expect(danglingWavCount(current.sqlitePath)).toBe(0);
    expect(fs.existsSync(youngWav)).toBe(true);
    expect(fs.existsSync(oldWav)).toBe(false);
    expect(fs.existsSync(crashWav)).toBe(false);
    expect(fs.existsSync(path.join(current.root, 'outside.wav'))).toBe(true);
    expect(fs.existsSync(path.join(blocked, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanYoung)).toBe(true);
    expect(readSegment(current.sqlitePath, 'missing').wavPath).toBeNull();
    expect(readSegment(current.sqlitePath, 'young').wavPath).toBe(youngWav);
    expect(readSegment(current.sqlitePath, 'blocked').wavPath).toBe(blocked);
    expect(readSegment(current.sqlitePath, 'outside').wavPath).toBe(outside);
  });

  it('refuses a wav_path outside audioDir and keeps the outside file', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const outside = `${current.audioDir}/../outside.wav`;
    const outsideFile = path.join(current.root, 'outside.wav');
    fs.writeFileSync(outsideFile, 'do-not-touch');
    insertSegment(current.sqlitePath, {
      id: 'hostile',
      wavPath: outside,
      transcript: 'secret',
      createdAtMs: now - 25 * HOUR_MS,
    });

    const summary = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    });

    expect(summary).toEqual({ deleted: 0, failed: 0, rowsUpdated: 0 });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('do-not-touch');
    expect(readSegment(current.sqlitePath, 'hostile')).toEqual({
      wavPath: outside,
      transcript: 'secret',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[音频保留] 拒绝删除音频文件',
      expect.objectContaining({ path: outside, reason: 'resolved path is outside audioDir' }),
    );
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });

  it('reports failed and leaves the row unchanged when deletion fails', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const blocked = writeBlockedWavDir(current.audioDir);
    const good = writeWav(current.audioDir, '2026-09-30', 'audio_good.wav');
    insertSegment(current.sqlitePath, {
      id: 'blocked',
      wavPath: blocked,
      transcript: 'keep me',
      createdAtMs: now,
    });
    insertSegment(current.sqlitePath, {
      id: 'good',
      wavPath: good,
      transcript: 'sibling',
      createdAtMs: now,
    });

    let summary = { deleted: -1, failed: -1, rowsUpdated: -1 };
    expect(() => {
      summary = sweepAudioRetention({
        sqlitePath: current.sqlitePath,
        audioDir: current.audioDir,
        now,
      });
    }).not.toThrow();

    expect(summary).toEqual({ deleted: 1, failed: 1, rowsUpdated: 1, lastError: 'not a regular file' });
    expect(fs.existsSync(path.join(blocked, 'keep.txt'))).toBe(true);
    expect(readSegment(current.sqlitePath, 'blocked')).toEqual({
      wavPath: blocked,
      transcript: 'keep me',
    });
    expect(fs.existsSync(good)).toBe(false);
    expect(readSegment(current.sqlitePath, 'good')).toEqual({
      wavPath: null,
      transcript: 'sibling',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[音频保留] 删除音频文件失败',
      expect.objectContaining({ path: blocked, reason: 'not a regular file' }),
    );
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });

  it('deletes unreferenced wav files older than 24h and keeps younger ones', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const oldWav = writeWav(current.audioDir, '2026-09-01', 'audio_old.wav');
    const youngWav = writeWav(current.audioDir, '2026-09-01', 'audio_young.wav');
    const notes = path.join(current.audioDir, '2026-09-01', 'notes.txt');
    fs.writeFileSync(notes, 'leave');
    const onlyOld = writeWav(current.audioDir, '2026-08-01', 'audio_only.wav');
    setMtime(oldWav, now - 25 * HOUR_MS);
    setMtime(notes, now - 25 * HOUR_MS);
    setMtime(youngWav, now - 23 * HOUR_MS);
    setMtime(onlyOld, now - 25 * HOUR_MS);

    const summary = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    });

    expect(summary).toEqual({ deleted: 2, failed: 0, rowsUpdated: 0 });
    expect(fs.existsSync(oldWav)).toBe(false);
    expect(fs.existsSync(youngWav)).toBe(true);
    expect(fs.existsSync(notes)).toBe(true);
    expect(fs.existsSync(onlyOld)).toBe(false);
    expect(fs.existsSync(path.join(current.audioDir, '2026-08-01'))).toBe(false);
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-01'))).toBe(true);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(danglingWavCount(current.sqlitePath)).toBe(0);

    const looseDir = path.join(current.root, 'loose');
    fs.mkdirSync(looseDir);
    const looseOld = path.join(looseDir, '2026-07-01', 'audio_loose.wav');
    fs.mkdirSync(path.dirname(looseOld), { recursive: true });
    fs.writeFileSync(looseOld, 'RIFF');
    setMtime(looseOld, now - 25 * HOUR_MS);
    const looseYoung = path.join(looseDir, '2026-07-02', 'audio_loose_young.wav');
    fs.mkdirSync(path.dirname(looseYoung), { recursive: true });
    fs.writeFileSync(looseYoung, 'RIFF');
    setMtime(looseYoung, now - HOUR_MS);
    const withoutDb = sweepAudioRetention({
      sqlitePath: null,
      audioDir: looseDir,
      now,
    });
    expect(withoutDb).toEqual({ deleted: 1, failed: 0, rowsUpdated: 0 });
    expect(fs.existsSync(looseOld)).toBe(false);
    expect(fs.existsSync(looseYoung)).toBe(true);

    expect(sweepAudioRetention({
      sqlitePath: null,
      audioDir: path.join(current.root, 'missing-audio'),
      now,
    })).toEqual({ deleted: 0, failed: 0, rowsUpdated: 0 });
  });

  it('nulls wav_path when the file is already missing', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = 1_800_000_000_000;
    const missing = path.join(current.audioDir, '2026-09-30', 'audio_missing.wav');
    insertSegment(current.sqlitePath, {
      id: 'missing',
      wavPath: missing,
      transcript: null,
      createdAtMs: now,
    });

    const summary = sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now,
    });

    expect(summary).toEqual({ deleted: 0, failed: 0, rowsUpdated: 1 });
    expect(readSegment(current.sqlitePath, 'missing')).toEqual({
      wavPath: null,
      transcript: null,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(danglingWavCount(current.sqlitePath)).toBe(0);
  });
});
