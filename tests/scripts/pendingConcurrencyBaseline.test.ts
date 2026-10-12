import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const scriptPath = join(repoRoot, 'scripts/pending-concurrency-baseline.mjs');

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

describe('pending concurrency baseline', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('reports paired waits, unpaired requests, and distinct-session overlap without mutating the DB', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pending-concurrency-baseline-'));
    const dbPath = join(tempRoot, 'fixture.db');
    const database = new Database(dbPath);
    database.exec(`
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    const insert = database.prepare(
      'INSERT INTO session_events (session_id, event_type, event_data, timestamp) VALUES (?, ?, ?, ?)',
    );
    const add = (sessionId: string, eventType: string, data: Record<string, unknown>, timestamp: number) => {
      insert.run(sessionId, eventType, JSON.stringify(data), timestamp);
    };

    add('session-a', 'permission_request', { id: 'req-a', parentToolUseId: 'tool-a', tool: 'write', type: 'file_write' }, 100);
    add('session-a', 'permission_request', { id: 'req-a-2', parentToolUseId: 'tool-a-2', tool: 'write', type: 'file_write' }, 150);
    add('session-a', 'tool_call_end', { toolCallId: 'tool-a-2', result: 'ok' }, 220);
    add('session-b', 'permission_request', { id: 'req-b', parentToolUseId: 'tool-b', tool: 'write', type: 'file_write' }, 200);
    add('session-a', 'tool_call_end', { toolCallId: 'tool-a', result: 'ok' }, 300);
    add('session-b', 'tool_call_end', { toolCallId: 'tool-b', result: 'ok' }, 400);
    add('session-unpaired', 'permission_request', { id: 'req-unpaired', parentToolUseId: 'tool-unpaired', tool: 'write', type: 'file_write' }, 450);
    add('session-timeout', 'permission_request', { id: 'req-timeout', tool: 'write', type: 'file_write' }, 500);
    add('session-timeout', 'permission_request', { id: 'req-timeout', resolved: true, decision: 'timeout', tool: 'write', type: 'file_write' }, 600);
    database.close();

    const before = digest(dbPath);
    const result = spawnSync(process.execPath, [scriptPath, '--db', dbPath, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      totalRequests: 5,
      pairedRequests: 4,
      unpairedRequests: 1,
      waitMs: { p50: 100, p90: 200 },
      concurrency: {
        overlapWindows: 1,
        overlapDurationMs: 100,
        totalPendingTimeMs: 400,
        overlapShare: 0.25,
        maxSimultaneousSessions: 2,
      },
    });
    expect(report.waitNote).toContain('upper bound');
    expect(digest(dbPath)).toBe(before);
  });
});
