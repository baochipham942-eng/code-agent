import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { createCloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

function openDb(file: string): BetterSqlite3.Database {
  const db = new Database(file);
  applySchema(db, logger);
  return db;
}

function request(sessionId: string, clientMessageId?: string) {
  return {
    sessionId,
    trigger: 'manual' as const,
    requestJson: JSON.stringify({ prompt: `work ${sessionId}`, sessionId }),
    clientMessageId,
  };
}

describe('CloudRunLedger admission', () => {
  let db: BetterSqlite3.Database;
  let accountId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    accountId = 'acct_a';
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it('keeps FIFO positions across a file database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-run-admission-'));
    const file = path.join(dir, 'ledger.db');
    const fileDb = openDb(file);
    try {
      const ledger = createCloudRunLedger({ db: fileDb, accountResolver: () => accountId });
      const first = ledger.admit(request('session_1'));
      const second = ledger.admit(request('session_2'));
      const third = ledger.admit(request('session_3'));
      const fourth = ledger.admit(request('session_4'));

      expect(first.record.state).toBe('running');
      expect(second.record.state).toBe('running');
      expect(third.record.state).toBe('queued');
      expect(third.position).toEqual({ queuePosition: 1, ahead: 0 });
      expect(fourth.position).toEqual({ queuePosition: 2, ahead: 1 });
      fileDb.close();

      const reopenedDb = openDb(file);
      const reopened = createCloudRunLedger({ db: reopenedDb, accountResolver: () => accountId });
      expect(reopened.readRun(third.record.runId)?.position).toEqual({ queuePosition: 1, ahead: 0 });
      expect(reopened.readRun(fourth.record.runId)?.position).toEqual({ queuePosition: 2, ahead: 1 });
      reopenedDb.close();
    } finally {
      if (fileDb.open) fileDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queues same-session work without spending another slot and returns an idempotent row', () => {
    const ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    const first = ledger.admit(request('session_same', 'message_1'));
    const duplicate = ledger.admit(request('session_same', 'message_1'));
    const second = ledger.admit(request('session_same', 'message_2'));

    expect(first.record.state).toBe('running');
    expect(duplicate.record.runId).toBe(first.record.runId);
    expect(duplicate.duplicate).toBe(true);
    expect(second.record.state).toBe('queued');
    expect(second.position).toEqual({ queuePosition: 1, ahead: 0 });
    expect(ledger.countInFlight(accountId)).toBe(1);
    expect(ledger.readRun(first.record.runId)?.record.runId).toBe(first.record.runId);
    accountId = 'acct_b';
    expect(ledger.readRun(first.record.runId)).toBeNull();
  });

  it('skips only a head blocked by its session and promotes exactly one row per freed slot', () => {
    const ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    const running = ledger.admit(request('session_running'));
    const occupying = ledger.admit(request('session_occupying'));
    const blockedHead = ledger.admit(request('session_running'));
    const promotable = ledger.admit(request('session_other'));

    expect(blockedHead.record.state).toBe('queued');
    expect(promotable.record.state).toBe('queued');
    ledger.transition(occupying.record.runId, 'succeeded');
    expect(ledger.promoteNext(accountId)?.runId).toBe(promotable.record.runId);
    expect(ledger.getRun(blockedHead.record.runId)?.state).toBe('queued');
    expect(ledger.promoteNext(accountId)).toBeNull();
    expect(ledger.countInFlight(accountId)).toBe(2);

    ledger.transition(promotable.record.runId, 'succeeded');
    expect(ledger.promoteNext(accountId)).toBeNull();
    ledger.transition(running.record.runId, 'succeeded');
    expect(ledger.promoteNext(accountId)?.runId).toBe(blockedHead.record.runId);
    expect(ledger.promoteNext(accountId)).toBeNull();
    expect(ledger.countInFlight(accountId)).toBe(1);
  });

  it('persists the request and binds an execution id only once', () => {
    const ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    const admitted = ledger.admit(request('session_bind'));
    ledger.bindExecutionRunId(admitted.record.runId, 'execution_1');

    expect(ledger.bindExecutionRunId(admitted.record.runId, 'execution_1').executionRunId).toBe('execution_1');
    expect(() => ledger.bindExecutionRunId(admitted.record.runId, 'execution_2')).toThrow(/different execution/);
    expect(ledger.getRun(admitted.record.runId)?.requestJson).toContain('work session_bind');
  });
});
