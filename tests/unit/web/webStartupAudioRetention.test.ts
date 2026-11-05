// ============================================================================
// N-AUDIO-SWEEP-ON-STARTUP：采集关着，启动也要清一次过期录音。
//
// 这里钉的是接线 + 行为合起来的真链路：kickoffStartupRetention()（webServer 启动期
// 调用，数据目录就绪后）→ sweepCapturedAudio → nativeDesktopService 在隔离数据目录
// 里解析 sqlite/audio 路径 → 真 sqlite3 子进程 + 真 fs 清理。全程不碰
// startDesktopAudioCapture——"采集关着"就是本文件的前提，不是被测行为。
//
// 断掉 webStartupRetention.ts 里的启动调用，本文件即红（反向变异锚点）。
// ============================================================================

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kickoffStartupRetention } from '../../../src/web/webStartupRetention';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  runLogRetention: vi.fn(),
  runDbRetention: vi.fn(),
  kickoffPresentationPreviewRetention: vi.fn(),
  kickoffAppCacheRetention: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

// 同文件里其余四项保留清理与本单无关，mock 掉兼作隔离：真实实现会扫
// getUserConfigDir()（未隔离时即真实 ~/.code-agent），测试绝不允许碰生产数据目录。
vi.mock('../../../src/host/services/infra/logRetention', () => ({
  runLogRetention: mocks.runLogRetention,
}));
vi.mock('../../../src/host/services/infra/dbRetention', () => ({
  runDbRetention: mocks.runDbRetention,
}));
vi.mock('../../../src/host/services/infra/presentationPreviewRetention', () => ({
  kickoffPresentationPreviewRetention: mocks.kickoffPresentationPreviewRetention,
}));
vi.mock('../../../src/host/services/infra/appCacheRetention', () => ({
  kickoffAppCacheRetention: mocks.kickoffAppCacheRetention,
}));

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

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-startup-sweep-'));
  // 目录形状对齐 nativeDesktopService.resolveDesktopRoot()：
  // CODE_AGENT_DATA_DIR/native-desktop/{desktop-activity.sqlite3,audio}
  const audioDir = path.join(root, 'native-desktop', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const sqlitePath = path.join(root, 'native-desktop', 'desktop-activity.sqlite3');
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

function readWavPaths(sqlitePath: string): Map<string, string | null> {
  const output = execFileSync(
    'sqlite3',
    ['-json', sqlitePath, 'SELECT id, wav_path FROM audio_segments;'],
    { encoding: 'utf-8' },
  ).trim();
  const rows = JSON.parse(output) as Array<{ id: string; wav_path: string | null }>;
  return new Map(rows.map((row) => [row.id, row.wav_path]));
}

function makeWav(dir: string, name: string, ageMs: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const wavPath = path.join(dir, `${name}.wav`);
  fs.writeFileSync(wavPath, 'RIFF-fixture');
  const stale = new Date(Date.now() - ageMs);
  fs.utimesSync(wavPath, stale, stale);
  return wavPath;
}

let fixture: Fixture | undefined;
let previousDataDir: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fixture = makeFixture();
  previousDataDir = process.env.CODE_AGENT_DATA_DIR;
  process.env.CODE_AGENT_DATA_DIR = fixture.root;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  previousDataDir = undefined;
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

// 动态 import 链（kickoff → desktopAudioCapture）+ 同步清扫体：轮询等可观测效果落地
function waitForSweep(effect: () => void): Promise<void> {
  return vi.waitFor(effect, { timeout: 10_000, interval: 50 });
}

describe('启动期音频保留清扫（采集关闭）', () => {
  it('kickoffStartupRetention 清掉过期 wav 与其 audio_segments 行，保留期内的不动', async () => {
    const now = Date.now();
    const expiredWav = makeWav(path.join(fixture!.audioDir, '2026-11-02'), 'expired', 25 * 60 * 60 * 1000);
    const keptWav = makeWav(path.join(fixture!.audioDir, '2026-11-04'), 'kept', 60 * 60 * 1000);
    const orphanWav = makeWav(path.join(fixture!.audioDir, '2026-11-02'), 'orphan', 25 * 60 * 60 * 1000);
    insertSegment(fixture!.sqlitePath, {
      id: 'seg-expired', wavPath: expiredWav, transcript: null, createdAtMs: now - 25 * 60 * 60 * 1000,
    });
    insertSegment(fixture!.sqlitePath, {
      id: 'seg-kept', wavPath: keptWav, transcript: null, createdAtMs: now - 60 * 60 * 1000,
    });

    expect(() => kickoffStartupRetention()).not.toThrow();

    await waitForSweep(() => {
      expect(fs.existsSync(expiredWav)).toBe(false);
    });

    // 过期行：wav 删掉 + 指针清空；孤儿过期文件：无行也删；保留期内：文件与行都原样
    expect(fs.existsSync(orphanWav)).toBe(false);
    expect(fs.existsSync(keptWav)).toBe(true);
    const rows = readWavPaths(fixture!.sqlitePath);
    expect(rows.get('seg-expired')).toBeNull();
    expect(rows.get('seg-kept')).toBe(keptWav);
  });

  it('清扫失败只留痕不炸启动：其余保留清理照常触发，文件不被误删', async () => {
    const keptWav = makeWav(path.join(fixture!.audioDir, '2026-11-04'), 'kept', 60 * 60 * 1000);
    // 库损坏注入：sqlite 存在（getSqlitePath 放行）但读不了行——清扫内部 fail-open，
    // 只 warn 不抛，且看不见行时保守地不删任何文件
    fs.writeFileSync(fixture!.sqlitePath, 'not a sqlite database');

    expect(() => kickoffStartupRetention()).not.toThrow();

    await waitForSweep(() => {
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        '[音频保留] 读取音频分段失败',
        expect.objectContaining({ reason: expect.any(String) }),
      );
      expect(mocks.runLogRetention).toHaveBeenCalled();
      expect(mocks.kickoffAppCacheRetention).toHaveBeenCalled();
    });

    expect(fs.existsSync(keptWav)).toBe(true);
  });
});
