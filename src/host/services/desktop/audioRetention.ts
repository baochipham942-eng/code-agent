// Retention for background-capture wavs.
// The row is written first. A non-empty transcript then loses its wav; a failed
// transcript (NULL or '') keeps the file for failedRetentionMs (default 24h).
// Only regular .wav files inside audioDir are unlinked. ENOENT counts as already
// gone. Sweep logs and continues; it does not throw.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../infra/logger';

const logger = createLogger('AudioRetention');

const FAILED_AUDIO_RETENTION_MS = 24 * 60 * 60 * 1000;
const DATE_DIR_NAME = /^\d{4}-\d{2}-\d{2}$/;

type RetentionSummary = { deleted: number; failed: number; rowsUpdated: number };

interface RetentionRow {
  id: string;
  wavPath: string;
  transcript: string | null;
  createdAtMs: number | null;
}

type WavInspection =
  | { action: 'missing' }
  | { action: 'refuse'; reason: string }
  | { action: 'fail'; reason: string }
  | { action: 'delete'; deletePath: string };

interface SweepContext {
  sqlitePath: string;
  audioDir: string;
  now: number;
  retentionMs: number;
  summary: RetentionSummary;
}

export function finalizeSegmentAudio(input: {
  sqlitePath: string;
  audioDir: string;
  segmentId: string;
  wavPath: string;
}): void {
  try {
    const inspection = inspectWav(input.audioDir, input.wavPath);
    if (inspection.action === 'missing') {
      clearPointer(input.sqlitePath, input.wavPath, input.segmentId);
      return;
    }
    if (inspection.action === 'refuse') {
      warnRefuse(input.wavPath, inspection.reason);
      return;
    }
    if (inspection.action === 'fail') {
      warnFail(input.wavPath, inspection.reason);
      return;
    }
    if (unlinkKeptWav(inspection.deletePath, input.wavPath) !== 'deleted') return;
    clearPointer(input.sqlitePath, input.wavPath, input.segmentId);
    removeEmptyDateDirs(input.audioDir);
  } catch (error) {
    logger.warn('[音频保留] 清理过程失败', { path: input.wavPath, reason: errorText(error) });
  }
}

export function sweepAudioRetention(input: {
  sqlitePath: string | null;
  audioDir: string;
  now: number;
  failedRetentionMs?: number;
}): RetentionSummary {
  const summary: RetentionSummary = { deleted: 0, failed: 0, rowsUpdated: 0 };
  try {
    runSweep(input, summary);
  } catch (error) {
    logger.warn('[音频保留] 清理过程失败', { reason: errorText(error) });
  }
  return summary;
}

function runSweep(
  input: { sqlitePath: string | null; audioDir: string; now: number; failedRetentionMs?: number },
  summary: RetentionSummary,
): void {
  const retentionMs = input.failedRetentionMs ?? FAILED_AUDIO_RETENTION_MS;
  // No database means no rows. A failed read must not orphan-delete files that
  // may still be referenced by rows we could not see.
  const rows = input.sqlitePath == null ? [] : loadRows(input.sqlitePath);
  if (rows == null) {
    removeEmptyDateDirs(input.audioDir);
    return;
  }

  const referenced = new Set<string>();
  for (const row of rows) addReference(referenced, row.wavPath);

  if (input.sqlitePath) {
    const ctx: SweepContext = {
      sqlitePath: input.sqlitePath,
      audioDir: input.audioDir,
      now: input.now,
      retentionMs,
      summary,
    };
    for (const row of rows) {
      try {
        processRow(row, ctx);
      } catch (error) {
        warnFail(row.wavPath, errorText(error));
        summary.failed += 1;
      }
    }
  }

  sweepOrphans(input.audioDir, referenced, input.now, retentionMs, summary);
  removeEmptyDateDirs(input.audioDir);
}

function processRow(row: RetentionRow, ctx: SweepContext): void {
  const inspection = inspectWav(ctx.audioDir, row.wavPath);
  if (inspection.action === 'missing') {
    if (clearPointer(ctx.sqlitePath, row.wavPath, row.id)) ctx.summary.rowsUpdated += 1;
    return;
  }

  const due = isNonEmpty(row.transcript) || isExpired(row.createdAtMs, ctx.now, ctx.retentionMs);
  if (!due) {
    if (inspection.action === 'refuse') warnRefuse(row.wavPath, inspection.reason);
    return;
  }
  if (inspection.action === 'refuse') {
    warnRefuse(row.wavPath, inspection.reason);
    return;
  }
  if (inspection.action === 'fail') {
    warnFail(row.wavPath, inspection.reason);
    ctx.summary.failed += 1;
    return;
  }
  if (unlinkKeptWav(inspection.deletePath, row.wavPath) !== 'deleted') {
    ctx.summary.failed += 1;
    return;
  }
  ctx.summary.deleted += 1;
  if (clearPointer(ctx.sqlitePath, row.wavPath, row.id)) ctx.summary.rowsUpdated += 1;
}

function sweepOrphans(
  audioDir: string,
  referenced: Set<string>,
  now: number,
  retentionMs: number,
  summary: RetentionSummary,
): void {
  for (const wavPath of listWavFiles(audioDir)) {
    if (isReferenced(referenced, wavPath)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(wavPath).mtimeMs;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      warnFail(wavPath, errorText(error));
      summary.failed += 1;
      continue;
    }
    // A young file with no row may still be queued for transcription.
    if (now - mtimeMs < retentionMs) continue;

    const inspection = inspectWav(audioDir, wavPath);
    if (inspection.action === 'missing') continue;
    if (inspection.action === 'refuse') {
      warnRefuse(wavPath, inspection.reason);
      continue;
    }
    if (inspection.action === 'fail') {
      warnFail(wavPath, inspection.reason);
      summary.failed += 1;
      continue;
    }
    if (unlinkKeptWav(inspection.deletePath, wavPath) !== 'deleted') {
      summary.failed += 1;
      continue;
    }
    summary.deleted += 1;
  }
}

function unlinkKeptWav(deletePath: string, wavPath: string): 'deleted' | 'failed' {
  try {
    fs.unlinkSync(deletePath);
    return 'deleted';
  } catch (error) {
    // Already gone: the pointer can be cleared and a later pass stays quiet.
    if (errorCode(error) === 'ENOENT') return 'deleted';
    warnFail(wavPath, errorText(error));
    return 'failed';
  }
}

function inspectWav(audioDir: string, wavPath: string): WavInspection {
  if (typeof wavPath !== 'string' || !wavPath.endsWith('.wav')) {
    return { action: 'refuse', reason: 'path does not end in .wav' };
  }
  let root: string;
  let canonical: string;
  try {
    root = canonicalPath(audioDir);
    canonical = canonicalPath(wavPath);
  } catch (error) {
    return { action: 'fail', reason: errorText(error) };
  }
  if (!isInside(root, canonical)) {
    return { action: 'refuse', reason: 'resolved path is outside audioDir' };
  }
  if (!canonical.endsWith('.wav')) {
    return { action: 'refuse', reason: 'resolved path does not end in .wav' };
  }
  try {
    const stat = fs.lstatSync(canonical);
    if (!stat.isFile()) return { action: 'fail', reason: 'not a regular file' };
    return { action: 'delete', deletePath: canonical };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { action: 'missing' };
    return { action: 'fail', reason: errorText(error) };
  }
}

function clearPointer(sqlitePath: string, wavPath: string, segmentId: string): boolean {
  const sql = `UPDATE audio_segments SET wav_path = NULL WHERE wav_path = '${sqlEscape(wavPath)}' OR id = '${sqlEscape(segmentId)}'; SELECT changes();`;
  try {
    const changed = Number(execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' }).trim());
    if (changed > 0) return true;
    logger.warn('[音频保留] 清空 wav_path 失败', {
      path: wavPath,
      reason: 'no matching audio_segments row',
    });
    return false;
  } catch (error) {
    logger.warn('[音频保留] 清空 wav_path 失败', { path: wavPath, reason: errorText(error) });
    return false;
  }
}

function loadRows(sqlitePath: string): RetentionRow[] | null {
  try {
    const sql = 'SELECT id, wav_path, transcript, created_at_ms FROM audio_segments WHERE wav_path IS NOT NULL;';
    const output = execFileSync('sqlite3', ['-json', sqlitePath, sql], { encoding: 'utf-8' }).trim();
    if (!output) return [];
    const parsed = parseUnknown(output);
    if (!Array.isArray(parsed)) throw new Error('audio_segments query did not return a JSON array');
    const rows: RetentionRow[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const id = item.id;
      const wavPath = item.wav_path;
      if (typeof id !== 'string' || typeof wavPath !== 'string' || wavPath.length === 0) continue;
      const transcript = item.transcript;
      const createdAt = item.created_at_ms;
      rows.push({
        id,
        wavPath,
        transcript: typeof transcript === 'string' ? transcript : null,
        createdAtMs: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null,
      });
    }
    return rows;
  } catch (error) {
    logger.warn('[音频保留] 读取音频分段失败', { reason: errorText(error) });
    return null;
  }
}

function listWavFiles(audioDir: string): string[] {
  let root: string;
  try {
    const stat = fs.lstatSync(audioDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    root = fs.realpathSync(audioDir);
  } catch {
    return [];
  }

  const found: string[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Do not follow a symlink out of audioDir. A linked .wav is inspected later.
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith('.wav')) found.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.wav')) found.push(full);
    }
  }
  return found;
}

function removeEmptyDateDirs(audioDir: string): void {
  let root: string;
  try {
    const stat = fs.lstatSync(audioDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    root = fs.realpathSync(audioDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    logger.warn('[音频保留] 移除空日期目录失败', { path: audioDir, reason: errorText(error) });
    return;
  }

  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    logger.warn('[音频保留] 移除空日期目录失败', { path: root, reason: errorText(error) });
    return;
  }

  for (const name of names) {
    if (!DATE_DIR_NAME.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (fs.readdirSync(dir).length > 0) continue;
      fs.rmdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      logger.warn('[音频保留] 移除空日期目录失败', { path: dir, reason: errorText(error) });
    }
  }
}

function addReference(referenced: Set<string>, wavPath: string): void {
  referenced.add(wavPath);
  referenced.add(path.resolve(wavPath));
  try {
    referenced.add(canonicalPath(wavPath));
  } catch {
    // Non-ENOENT failures still leave the raw path in the set.
  }
}

function isReferenced(referenced: Set<string>, wavPath: string): boolean {
  if (referenced.has(wavPath) || referenced.has(path.resolve(wavPath))) return true;
  try {
    return referenced.has(canonicalPath(wavPath));
  } catch {
    return false;
  }
}

function canonicalPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}

function isNonEmpty(transcript: string | null): boolean {
  return typeof transcript === 'string' && transcript.length > 0;
}

function isExpired(createdAtMs: number | null, now: number, retentionMs: number): boolean {
  return createdAtMs != null && now - createdAtMs >= retentionMs;
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function parseUnknown(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function warnRefuse(wavPath: string, reason: string): void {
  logger.warn('[音频保留] 拒绝删除音频文件', { path: wavPath, reason });
}

function warnFail(wavPath: string, reason: string): void {
  logger.warn('[音频保留] 删除音频文件失败', { path: wavPath, reason });
}
