import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  sqlitePath: '',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => harness.logger,
}));

vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({
    getStatus: () => ({ sqliteDbPath: harness.sqlitePath, running: false }),
  }),
}));

import {
  clearAllAudioRecordings,
  finalizeSegmentAudio,
  getAudioRetentionStatus,
  sweepAudioRetention,
} from '../../../../src/host/services/desktop/audioRetention';
import { getAudioCaptureStatus } from '../../../../src/host/services/desktop/desktopAudioCapture';
import { FAILED_AUDIO_RETENTION_MS } from '@shared/constants/desktopAudio';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-retention-clear-'));
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

function writeWav(audioDir: string, day: string, name: string, bytes: string): string {
  const wavPath = path.join(audioDir, day, name);
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  fs.writeFileSync(wavPath, bytes);
  return wavPath;
}

function setMtime(wavPath: string, atMs: number): void {
  const when = new Date(atMs);
  fs.utimesSync(wavPath, when, when);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture = makeFixture();
  harness.sqlitePath = fixture.sqlitePath;
});

afterEach(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
  harness.sqlitePath = '';
});

describe('clearAllAudioRecordings', () => {
  it('deletes nested wavs, nulls wav_path, keeps transcripts, and reports bytes', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const first = writeWav(current.audioDir, '2026-09-01', 'audio_a.wav', 'RIFF-AAAA');
    const second = writeWav(current.audioDir, '2026-09-02', 'audio_b.wav', 'RIFF-BB');
    const expectedBytes = fs.statSync(first).size + fs.statSync(second).size;
    const notes = path.join(current.audioDir, '2026-09-01', 'notes.txt');
    fs.writeFileSync(notes, 'leave-me');
    fs.mkdirSync(path.join(current.audioDir, '2026-08-01'));
    const missing = path.join(current.audioDir, '2026-09-03', 'audio_missing.wav');
    insertSegment(current.sqlitePath, {
      id: 'a',
      wavPath: first,
      transcript: 'hello one',
      createdAtMs: 1,
    });
    insertSegment(current.sqlitePath, {
      id: 'b',
      wavPath: second,
      transcript: 'hello two',
      createdAtMs: 2,
    });
    insertSegment(current.sqlitePath, {
      id: 'gone',
      wavPath: missing,
      transcript: 'already gone',
      createdAtMs: 3,
    });

    const result = clearAllAudioRecordings({
      audioDir: current.audioDir,
      sqlitePath: current.sqlitePath,
    });

    expect(result.deleted).toBe(2);
    expect(result.freedBytes).toBe(expectedBytes);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(notes)).toBe(true);
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-02'))).toBe(false);
    expect(fs.existsSync(path.join(current.audioDir, '2026-08-01'))).toBe(false);
    expect(fs.existsSync(path.join(current.audioDir, '2026-09-01'))).toBe(true);
    expect(readSegment(current.sqlitePath, 'a')).toEqual({ wavPath: null, transcript: 'hello one' });
    expect(readSegment(current.sqlitePath, 'b')).toEqual({ wavPath: null, transcript: 'hello two' });
    expect(readSegment(current.sqlitePath, 'gone')).toEqual({ wavPath: null, transcript: 'already gone' });
  });

  it('refuses a wav_path outside audioDir and keeps that file', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const outside = path.join(current.root, 'outside.wav');
    fs.writeFileSync(outside, 'do-not-touch');
    const pointed = `${current.audioDir}/../outside.wav`;
    insertSegment(current.sqlitePath, {
      id: 'hostile',
      wavPath: pointed,
      transcript: 'secret',
      createdAtMs: 1,
    });

    const result = clearAllAudioRecordings({
      audioDir: current.audioDir,
      sqlitePath: current.sqlitePath,
    });

    expect(fs.readFileSync(outside, 'utf8')).toBe('do-not-touch');
    expect(readSegment(current.sqlitePath, 'hostile')).toEqual({
      wavPath: pointed,
      transcript: 'secret',
    });
    expect(result.failed).toBeGreaterThan(0);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[音频保留] 拒绝删除音频文件',
      expect.objectContaining({ reason: 'resolved path is outside audioDir' }),
    );
  });

  it('counts a non-empty directory path as a deletion failure and leaves the row', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const blocked = path.join(current.audioDir, '2026-09-15', 'audio_blocked.wav');
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, 'keep.txt'), 'keep');
    insertSegment(current.sqlitePath, {
      id: 'blocked',
      wavPath: blocked,
      transcript: 'keep me',
      createdAtMs: 1,
    });

    let result = { deleted: -1, freedBytes: -1, failed: -1 };
    expect(() => {
      result = clearAllAudioRecordings({
        audioDir: current.audioDir,
        sqlitePath: current.sqlitePath,
      });
    }).not.toThrow();

    expect(result.failed).toBeGreaterThan(0);
    expect(result.deleted).toBe(0);
    expect(fs.existsSync(path.join(blocked, 'keep.txt'))).toBe(true);
    expect(readSegment(current.sqlitePath, 'blocked')).toEqual({
      wavPath: blocked,
      transcript: 'keep me',
    });
  });

  it('keeps a young wav with no audio_segments row (may still be queued for ASR)', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const now = Date.now();
    // No row yet: a queued wav is only written to audio_segments after ASR.
    const queued = writeWav(current.audioDir, '2026-09-20', 'audio_queued.wav', 'RIFF-QUEUED');
    const stale = writeWav(current.audioDir, '2026-09-20', 'audio_stale.wav', 'RIFF-STALE');
    const transcribed = writeWav(current.audioDir, '2026-09-20', 'audio_done.wav', 'RIFF-DONE');
    setMtime(queued, now - 60_000);
    setMtime(stale, now - FAILED_AUDIO_RETENTION_MS - 60_000);
    const expectedBytes = fs.statSync(stale).size + fs.statSync(transcribed).size;
    insertSegment(current.sqlitePath, {
      id: 'done',
      wavPath: transcribed,
      transcript: 'already transcribed',
      createdAtMs: now,
    });

    const counts = getAudioRetentionStatus(current.audioDir, current.sqlitePath);
    expect(counts.fileCount).toBe(2);
    expect(counts.bytes).toBe(expectedBytes);

    const result = clearAllAudioRecordings({
      audioDir: current.audioDir,
      sqlitePath: current.sqlitePath,
      now,
    });

    expect(result.deleted).toBe(2);
    expect(result.freedBytes).toBe(expectedBytes);
    expect(fs.existsSync(queued)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(transcribed)).toBe(false);
    expect(readSegment(current.sqlitePath, 'done')).toEqual({
      wavPath: null,
      transcript: 'already transcribed',
    });
  });

  it('accumulates failedTotal and lastError onto the capture status', () => {
    const current = fixture;
    if (!current) throw new Error('missing fixture');
    const blocked = path.join(current.audioDir, '2026-09-15', 'audio_blocked.wav');
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, 'keep.txt'), 'keep');
    insertSegment(current.sqlitePath, {
      id: 'blocked',
      wavPath: blocked,
      transcript: 'keep me',
      createdAtMs: 1,
    });
    const before = getAudioRetentionStatus();

    finalizeSegmentAudio({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      segmentId: 'blocked',
      wavPath: blocked,
    });
    const afterFinalize = getAudioRetentionStatus();
    expect(afterFinalize.failedTotal).toBe(before.failedTotal + 1);
    expect(afterFinalize.lastError).toBe('not a regular file');

    sweepAudioRetention({
      sqlitePath: current.sqlitePath,
      audioDir: current.audioDir,
      now: 1_800_000_000_000,
    });
    const afterSweep = getAudioRetentionStatus();
    expect(afterSweep.failedTotal).toBe(before.failedTotal + 2);
    expect(afterSweep.lastError).toBe('not a regular file');

    clearAllAudioRecordings({
      audioDir: current.audioDir,
      sqlitePath: current.sqlitePath,
    });
    const afterClear = getAudioRetentionStatus();
    expect(afterClear.failedTotal).toBe(before.failedTotal + 3);
    expect(afterClear.lastError).toBe('not a regular file');
    expect(afterClear.lastSweepAt).not.toBeNull();
    expect(getAudioCaptureStatus().retention).toMatchObject({
      failedTotal: afterClear.failedTotal,
      lastError: 'not a regular file',
    });
  });
});
