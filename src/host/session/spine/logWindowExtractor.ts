import fs from 'node:fs';
import path from 'node:path';
import { sanitizePackageValue, type SessionPackagePrivacyLevel } from './packageSanitizer';

const WINDOW_PADDING_MS = 5 * 60 * 1000;

function dateKeys(start: number, end: number): string[] {
  const keys: string[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function timestampOf(record: Record<string, unknown>): number | null {
  const raw = record.timestamp;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const value = Date.parse(raw);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Extract exact session rows plus explicitly marked weak, time-window-only rows across day files. */
export function extractLogWindow(options: {
  logDir: string;
  sessionId: string;
  sessionStart: number;
  sessionEnd: number;
  privacyLevel: SessionPackagePrivacyLevel;
  homeDir?: string;
}): Array<Record<string, unknown>> {
  const start = options.sessionStart - WINDOW_PADDING_MS;
  const end = options.sessionEnd + WINDOW_PADDING_MS;
  const output: Array<Record<string, unknown>> = [];
  for (const key of dateKeys(start, end)) {
    const file = path.join(options.logDir, `code-agent-${key}.log`);
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const timestamp = timestampOf(record);
      if (timestamp === null || timestamp < start || timestamp > end) continue;
      if (typeof record.sessionId === 'string' && record.sessionId !== options.sessionId) continue;
      output.push(typeof record.sessionId === 'string' ? record : { ...record, confidence: 'weak' });
    }
  }
  return sanitizePackageValue(output, options.privacyLevel, options.homeDir);
}

export function sessionWindowDateKeys(start: number, end: number): string[] {
  return dateKeys(start - WINDOW_PADDING_MS, end + WINDOW_PADDING_MS);
}
