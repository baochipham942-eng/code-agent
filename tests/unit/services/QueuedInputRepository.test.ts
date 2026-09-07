import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { SteerRejectedError } from '../../../src/host/agent/runtime/conversationRuntime';
import { applySameIdQueuedInput } from '../../../src/host/runtime/applySameIdQueuedInput';
import { steerOrQueue } from '../../../src/host/runtime/steerQueueFence';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT,
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
      position: 0,
      pausedReason: null,
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
      position: 0,
      pausedReason: null,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('listBySession 只返回指定 session 并按 position 排列', () => {
    repo.enqueue({ id: 'a-later', sessionId: 'session-a', envelope: { order: 2 }, now: 300 });
    repo.enqueue({ id: 'b-middle', sessionId: 'session-b', envelope: { order: 9 }, now: 200 });
    repo.enqueue({ id: 'a-first', sessionId: 'session-a', envelope: { order: 1 }, now: 100 });

    const sessionA = repo.listBySession('session-a');

    expect(sessionA.map((record) => record.id)).toEqual(['a-later', 'a-first']);
    expect(sessionA.map((record) => record.position)).toEqual([0, 1]);
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

  it('updateEnvelope 写入正文和附件', () => {
    repo.enqueue({
      id: 'input-1',
      sessionId: 'session-1',
      envelope: { content: 'old', attachments: [{ id: 'a', name: 'a.png', type: 'image/png', size: 1 }] },
      now: 100,
    });
    expect(repo.updateEnvelope(
      'input-1',
      JSON.stringify({
        content: 'new',
        attachments: [{ id: 'b', name: 'b.png', type: 'image/png', size: 2 }],
      }),
      200,
    )).toBe(true);
    expect(JSON.parse(repo.getById('input-1')?.envelopeJson ?? '{}')).toEqual({
      content: 'new',
      attachments: [{ id: 'b', name: 'b.png', type: 'image/png', size: 2 }],
    });
    expect(repo.getById('input-1')?.updatedAt).toBe(200);
  });

  it('updateEnvelope 对 sending 行返回 false', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: { content: 'old' }, now: 100 });
    expect(repo.markSending('input-1', 150)).toBe(true);
    expect(repo.updateEnvelope('input-1', JSON.stringify({ content: 'new' }), 200)).toBe(false);
    expect(JSON.parse(repo.getById('input-1')?.envelopeJson ?? '{}')).toEqual({ content: 'old' });
  });

  it('requeue 把 failed 恢复为 queued 并写入新 envelope、重置 retry', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: { content: 'old' }, now: 100 });
    expect(repo.markFailed('input-1', 200)).toBe(true);
    expect(repo.getNextDispatchable('session-1')).toBeNull();
    expect(repo.requeue('input-1', JSON.stringify({ content: 'old', attachments: [] }), 300)).toBe(true);
    expect(repo.getById('input-1')).toMatchObject({
      status: 'queued',
      retryCount: 0,
      pausedReason: null,
      updatedAt: 300,
    });
    expect(JSON.parse(repo.getById('input-1')?.envelopeJson ?? '{}')).toEqual({
      content: 'old',
      attachments: [],
    });
    expect(repo.getNextDispatchable('session-1')?.id).toBe('input-1');
    expect(repo.markSending('input-1', 400)).toBe(true);
  });

  it('requeue 把 retracted 恢复为 queued', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: { content: 'old' }, now: 100 });
    expect(repo.retract('input-1', 200)).toBe(true);
    expect(repo.getNextDispatchable('session-1')).toBeNull();
    expect(repo.requeue('input-1', JSON.stringify({ content: 'new' }), 300)).toBe(true);
    expect(repo.getById('input-1')).toMatchObject({ status: 'queued', updatedAt: 300 });
    expect(JSON.parse(repo.getById('input-1')?.envelopeJson ?? '{}')).toEqual({ content: 'new' });
    expect(repo.getNextDispatchable('session-1')?.id).toBe('input-1');
  });

  it('requeue 对 sending 行返回 false', () => {
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: { content: 'old' }, now: 100 });
    expect(repo.markSending('input-1', 150)).toBe(true);
    expect(repo.requeue('input-1', JSON.stringify({ content: 'new' }), 200)).toBe(false);
    expect(repo.getById('input-1')).toMatchObject({ status: 'sending', updatedAt: 150 });
  });

  it('显式传入的固定时间戳会精确写入 updated_at', () => {
    const fixedTimestamp = 1_700_000_000_000;
    repo.enqueue({ id: 'input-1', sessionId: 'session-1', envelope: {}, now: 100 });

    expect(repo.markSending('input-1', fixedTimestamp)).toBe(true);
    expect(repo.getById('input-1')?.updatedAt).toBe(fixedTimestamp);
  });

  it('reorder 在一个事务内批量改 position，listBySession 立即反映新顺序', () => {
    repo.enqueue({ id: 'first', sessionId: 'session-1', envelope: {}, now: 100 });
    repo.enqueue({ id: 'second', sessionId: 'session-1', envelope: {}, now: 200 });
    repo.enqueue({ id: 'third', sessionId: 'session-1', envelope: {}, now: 300 });

    expect(repo.reorder('session-1', ['third', 'first', 'second'], 400)).toBe(true);
    expect(repo.listBySession('session-1').map((record) => record.id))
      .toEqual(['third', 'first', 'second']);
    expect(repo.listBySession('session-1').map((record) => record.position))
      .toEqual([0, 1, 2]);
  });

  it('reorder 中途写失败时整段 position 回滚', () => {
    repo.enqueue({ id: 'first', sessionId: 'session-1', envelope: {}, now: 100 });
    repo.enqueue({ id: 'second', sessionId: 'session-1', envelope: {}, now: 200 });
    db.exec(`
      CREATE TRIGGER reject_second_position
      BEFORE UPDATE OF position ON queued_inputs
      WHEN NEW.id = 'second'
      BEGIN
        SELECT RAISE(ABORT, 'reject second');
      END;
    `);

    expect(() => repo.reorder('session-1', ['second', 'first'], 300)).toThrow('reject second');
    expect(repo.listBySession('session-1').map((record) => [record.id, record.position]))
      .toEqual([['first', 0], ['second', 1]]);
  });

  it('旧表迁移按 created_at 回填 position，并补 paused_reason 与 position 索引', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE queued_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO queued_inputs VALUES
        ('later', 's1', '{}', 'queued', 0, 200, 200),
        ('earlier', 's1', '{}', 'queued', 0, 100, 100),
        ('other', 's2', '{}', 'queued', 0, 150, 150);
    `);
    const migrationLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Parameters<typeof applySchema>[1];
    applySchema(legacy, migrationLogger);

    const migrated = legacy.prepare(
      'SELECT id, position, paused_reason FROM queued_inputs ORDER BY session_id, position',
    ).all();
    expect(migrated).toEqual([
      { id: 'earlier', position: 0, paused_reason: null },
      { id: 'later', position: 1, paused_reason: null },
      { id: 'other', position: 0, paused_reason: null },
    ]);
    const indexes = legacy.prepare("PRAGMA index_list('queued_inputs')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_queued_inputs_position');
    legacy.close();
  });
});

describe('steer 回退入队走同一套同 id 状态机', () => {
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

  it('同 id 已 queued 时插话回退入队更新为新稿，不被 INSERT OR IGNORE', async () => {
    repo.enqueue({
      id: 'same-id',
      sessionId: 'session-1',
      envelope: { content: '原文 A', attachments: [] },
      now: 100,
    });

    const outcome = await steerOrQueue(
      { steer: vi.fn().mockRejectedValue(new SteerRejectedError()) },
      { sessionId: 'session-1', content: '改过的需求 B', clientMessageId: 'same-id' },
      repo,
    );

    expect(outcome).toMatchObject({ outcome: 'queued', queuedInputId: 'same-id' });
    expect(JSON.parse(repo.getById('same-id')?.envelopeJson ?? '{}')).toEqual(
      expect.objectContaining({ content: '改过的需求 B' }),
    );
    expect(repo.listBySession('session-1')).toHaveLength(1);
    expect(repo.getNextDispatchable('session-1')?.id).toBe('same-id');
  });

  it('applySameId 对 failed 行 requeue 为可抽干的 queued', () => {
    repo.enqueue({
      id: 'same-id',
      sessionId: 'session-1',
      envelope: { content: '原文 A' },
      now: 100,
    });
    expect(repo.markFailed('same-id', 200)).toBe(true);

    const accepted = applySameIdQueuedInput(repo, {
      id: 'same-id',
      sessionId: 'session-1',
      envelope: { content: '原文 A', attachments: [] },
      now: 300,
    });

    expect(accepted).toMatchObject({ id: 'same-id', action: 'requeue' });
    expect(repo.getById('same-id')).toMatchObject({ status: 'queued', pausedReason: null });
    expect(repo.getNextDispatchable('session-1')?.id).toBe('same-id');
  });
});
