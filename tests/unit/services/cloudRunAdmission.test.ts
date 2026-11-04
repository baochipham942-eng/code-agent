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

// ============================================================================
// ADR-087 S4B：通道幂等键 (account_id, channel_delivery_id)。
// 同一次通道投递重放只算一次准入：一行、同 runId、同位置、不重复占 slot；
// 键按账户隔离；非 channel trigger 带 key / channel 行缺 key 都在账本层拒绝。
// ============================================================================
  function runCount(database: BetterSqlite3.Database): number {
    return Number((database.prepare('SELECT COUNT(*) AS total FROM cloud_runs').get() as { total: number }).total);
  }


  function channelRequest(sessionId: string, channelDeliveryId: string) {
    return {
      sessionId,
      trigger: 'channel' as const,
      requestJson: JSON.stringify({ prompt: `channel ${sessionId}`, sessionId }),
      channelDeliveryId,
    };
  }

  function inFlightCount(database: BetterSqlite3.Database): number {
    return Number(
      (
        database.prepare(
          "SELECT COUNT(*) AS c FROM cloud_runs WHERE state IN ('running', 'waiting-approval', 'waiting-reconnect')",
        ).get() as { c: number }
      ).c,
    );
  }

  it('① same (account, channelDeliveryId) twice → one row, same runId, same position, in-flight unchanged', () => {
    const ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    const first = ledger.admit(channelRequest('session_channel', 'cd-1'));
    const second = ledger.admit(channelRequest('session_channel', 'cd-1'));

    expect(second.duplicate).toBe(true);
    expect(second.record.runId).toBe(first.record.runId);
    expect(second.position).toEqual(first.position);
    expect(second.record.channelDeliveryId).toBe('cd-1');
    expect(runCount(db)).toBe(1);
    expect(inFlightCount(db)).toBe(1);
  });

  it('② same channelDeliveryId for a different account creates a separate row', () => {
    const ledgerA = createCloudRunLedger({ db, accountResolver: () => 'acct_a' });
    const ledgerB = createCloudRunLedger({ db, accountResolver: () => 'acct_b' });
    const a = ledgerA.admit(channelRequest('session_a', 'cd-shared'));
    const b = ledgerB.admit(channelRequest('session_b', 'cd-shared'));

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(b.record.runId).not.toBe(a.record.runId);
    expect(runCount(db)).toBe(2);
  });

  it('trigger/key pairing: channelDeliveryId on non-channel trigger rejects; channel without key rejects', () => {
    const ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    expect(() => ledger.admit({ ...channelRequest('session_x', 'cd-x'), trigger: 'manual' as const }))
      .toThrowError('Cloud run channelDeliveryId is only valid with trigger channel');
    expect(() => ledger.admit({ sessionId: 'session_x', trigger: 'channel', requestJson: '{}' }))
      .toThrowError('Cloud run trigger channel requires a non-empty channelDeliveryId');
    // 空白 key 与无 key 同罪
    expect(() => ledger.admit({ sessionId: 'session_x', trigger: 'channel', requestJson: '{}', channelDeliveryId: '   ' }))
      .toThrowError('Cloud run trigger channel requires a non-empty channelDeliveryId');
    expect(runCount(db)).toBe(0);
  });
});
