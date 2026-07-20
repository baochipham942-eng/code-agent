import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_inputs_session
      ON queued_inputs (session_id, status, created_at);
  `);
}

describe('QueuedInputRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: QueuedInputRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    repo = new QueuedInputRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueue 后可按 id 读回 queued 行', () => {
    repo.enqueue({
      id: 'input-1',
      sessionId: 'session-1',
      envelope: { content: 'first input' },
      now: 100,
    });

    expect(repo.getById('input-1')).toEqual({
      id: 'input-1',
      sessionId: 'session-1',
      envelopeJson: JSON.stringify({ content: 'first input' }),
      status: 'queued',
      retryCount: 0,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('重复 enqueue 同一 id 时保留第一次写入的内容', () => {
    repo.enqueue({
      id: 'input-1',
      sessionId: 'session-first',
      envelope: { content: 'first input' },
      now: 100,
    });
    repo.enqueue({
      id: 'input-1',
      sessionId: 'session-second',
      envelope: { content: 'replacement input' },
      now: 200,
    });

    expect(repo.getById('input-1')).toEqual({
      id: 'input-1',
      sessionId: 'session-first',
      envelopeJson: JSON.stringify({ content: 'first input' }),
      status: 'queued',
      retryCount: 0,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('listBySession 只返回指定 session 并按 created_at 升序排列', () => {
    repo.enqueue({ id: 'a-later', sessionId: 'session-a', envelope: { order: 2 }, now: 300 });
    repo.enqueue({ id: 'b-middle', sessionId: 'session-b', envelope: { order: 9 }, now: 200 });
    repo.enqueue({ id: 'a-first', sessionId: 'session-a', envelope: { order: 1 }, now: 100 });

    const sessionA = repo.listBySession('session-a');

    expect(sessionA.map((record) => record.id)).toEqual(['a-first', 'a-later']);
    expect(sessionA.map((record) => record.createdAt)).toEqual([100, 300]);
    expect(sessionA.every((record) => record.sessionId === 'session-a')).toBe(true);
    expect(repo.listBySession('session-b').map((record) => record.id)).toEqual(['b-middle']);
  });

  it('listSessionsWithQueuedInputs 只返回有 queued 行的 session，去重并按最早排队时间排序', () => {
    repo.enqueue({ id: 'later-first', sessionId: 'session-later', envelope: {}, now: 300 });
    repo.enqueue({ id: 'earlier-second', sessionId: 'session-earlier', envelope: {}, now: 200 });
    repo.enqueue({ id: 'earlier-first', sessionId: 'session-earlier', envelope: {}, now: 100 });

    expect(repo.listSessionsWithQueuedInputs()).toEqual(['session-earlier', 'session-later']);
  });

  it('listSessionsWithQueuedInputs 不含 consumed、retracted、failed 和 sending 行', () => {
    repo.enqueue({ id: 'queued', sessionId: 'session-queued', envelope: {}, now: 100 });
    repo.enqueue({ id: 'consumed', sessionId: 'session-consumed', envelope: {}, now: 110 });
    repo.enqueue({ id: 'retracted', sessionId: 'session-retracted', envelope: {}, now: 120 });
    repo.enqueue({ id: 'failed', sessionId: 'session-failed', envelope: {}, now: 130 });
    repo.enqueue({ id: 'sending', sessionId: 'session-sending', envelope: {}, now: 140 });

    expect(repo.markSending('consumed')).toBe(true);
    expect(repo.markConsumed('consumed')).toBe(true);
    expect(repo.retract('retracted')).toBe(true);
    expect(repo.markFailed('failed')).toBe(true);
    expect(repo.markSending('sending')).toBe(true);

    expect(repo.listSessionsWithQueuedInputs()).toEqual(['session-queued']);
  });

  it('markSending 只能从 queued 出发，重复调用不改变状态和 updated_at', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });

    expect(repo.markSending('input-1', 200)).toBe(true);
    expect(repo.getById('input-1')).toMatchObject({ status: 'sending', updatedAt: 200 });

    expect(repo.markSending('input-1', 300)).toBe(false);
    expect(repo.getById('input-1')).toMatchObject({ status: 'sending', updatedAt: 200 });
  });

  it('markConsumed 只允许 sending 转为 consumed', () => {
    repo.enqueue({ id: 'sending-input', sessionId: 'session-1', envelope: {}, now: 100 });
    repo.enqueue({ id: 'queued-input', sessionId: 'session-1', envelope: {}, now: 110 });
    expect(repo.markSending('sending-input', 200)).toBe(true);

    expect(repo.markConsumed('sending-input', 300)).toBe(true);
    expect(repo.getById('sending-input')).toMatchObject({ status: 'consumed', updatedAt: 300 });

    expect(repo.markConsumed('queued-input', 400)).toBe(false);
    expect(repo.getById('queued-input')).toMatchObject({ status: 'queued', updatedAt: 110 });
  });

  it('requeueAfterFailure 只从 sending 重排并递增 retryCount', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });
    expect(repo.markSending('input-1', 200)).toBe(true);

    expect(repo.requeueAfterFailure('input-1', 300)).toEqual({ retryCount: 1 });
    expect(repo.getById('input-1')).toMatchObject({
      status: 'queued',
      retryCount: 1,
      updatedAt: 300,
    });

    expect(repo.requeueAfterFailure('input-1', 400)).toBeNull();
    expect(repo.getById('input-1')).toMatchObject({
      status: 'queued',
      retryCount: 1,
      updatedAt: 300,
    });
  });

  it('markFailed 后进入终态，不能重新排队或发送', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });
    expect(repo.markSending('input-1', 200)).toBe(true);
    expect(repo.markFailed('input-1', 300)).toBe(true);

    expect(repo.requeueAfterFailure('input-1', 400)).toBeNull();
    expect(repo.markSending('input-1', 500)).toBe(false);
    expect(repo.getById('input-1')).toMatchObject({ status: 'failed', updatedAt: 300 });
  });

  it('retract 可将 queued 行撤回', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });

    expect(repo.retract('input-1', 200)).toBe(true);
    expect(repo.getById('input-1')).toMatchObject({ status: 'retracted', updatedAt: 200 });
  });

  it('retract 不能撤回 sending 行且不改变原状态', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });
    expect(repo.markSending('input-1', 200)).toBe(true);

    expect(repo.retract('input-1', 300)).toBe(false);
    expect(repo.getById('input-1')).toMatchObject({ status: 'sending', updatedAt: 200 });
  });

  it('retract 不能撤回 consumed 行且不改变原状态', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });
    expect(repo.markSending('input-1', 200)).toBe(true);
    expect(repo.markConsumed('input-1', 300)).toBe(true);

    expect(repo.retract('input-1', 400)).toBe(false);
    expect(repo.getById('input-1')).toMatchObject({ status: 'consumed', updatedAt: 300 });
  });

  it('显式传入的固定时间戳会精确写入 updated_at', () => {
    const fixedTimestamp = 1_700_000_000_000;
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });

    expect(repo.markSending('input-1', fixedTimestamp)).toBe(true);
    expect(repo.getById('input-1')?.updatedAt).toBe(fixedTimestamp);
  });
});
