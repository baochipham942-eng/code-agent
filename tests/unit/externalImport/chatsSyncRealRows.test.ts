// Hermetic wrapper for scripts/acceptance/exthistory-sync-real-rows.ts:
// temp HOME + temp data dir + real SQLite, no network, no model calls.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../scripts/acceptance/exthistory-sync-real-rows.ts');

describe('keep-chats-in-sync real-rows acceptance script', () => {
  it('writes rows, keeps origin/engine in the list payload, is idempotent, and survives off/paused', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT], { encoding: 'utf8', timeout: 120_000 });
    const out = `${result.stdout}\n${result.stderr}`;
    expect(out).toContain('after setChatsSyncMode(on): sessions=2 messages=8 ledger=2');
    expect(out).toContain('holds for all: true');
    expect(out).toContain('after setChatsSyncMode(off): sessions=2 messages=8 ledger=2');
    expect(out).toContain('after setChatsSyncMode(paused): sessions=2 messages=8 ledger=2');
    expect(out).toContain('=== EXTHISTORY SYNC REAL ROWS PASS ===');
    expect(result.status).toBe(0);
  }, 150_000);
});
