import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { HandoffProposalService } from '../../../src/main/handoff/handoffProposalService';

describe('HandoffProposalService', () => {
  let service: HandoffProposalService;
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    database.getDb = () => dbState.sqlite;
    service = new HandoffProposalService();
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('creates pending proposals from assistant-tail drafts', () => {
    const item = service.create({
      sessionId: 'session-1',
      sourceMessageId: 'assistant-1',
      title: '整理成文档',
      prompt: '把上面的结论整理成一份文档。',
      reason: '用户后面可能需要沉淀。',
      createdAt: 100,
    });

    expect(item).toMatchObject({
      id: 'handoff:session-1:assistant-1',
      sessionId: 'session-1',
      sourceMessageId: 'assistant-1',
      source: 'assistant_tail',
      status: 'pending',
      title: '整理成文档',
      prompt: '把上面的结论整理成一份文档。',
      reason: '用户后面可能需要沉淀。',
      createdAt: 100,
      updatedAt: 100,
    });
    expect(service.list({ sessionId: 'session-1' })).toHaveLength(1);
  });

  it('deduplicates pending proposals with the same session and prompt', () => {
    const first = service.create({
      sessionId: 'session-1',
      sourceMessageId: 'assistant-1',
      title: '继续 A',
      prompt: '继续同一个动作。',
      createdAt: 100,
    });
    const second = service.create({
      sessionId: 'session-1',
      sourceMessageId: 'assistant-2',
      title: '继续 B',
      prompt: '继续同一个动作。',
      createdAt: 200,
    });

    expect(second.id).toBe(first.id);
    expect(service.list({ sessionId: 'session-1' })).toHaveLength(1);
  });

  it('persists long-task recovery proposal sources', () => {
    const item = service.create({
      sessionId: 'session-1',
      sourceMessageId: 'workflow:wf-1:failure',
      source: 'workflow_failure',
      title: '重试 workflow',
      prompt: '继续失败 workflow。',
      createdAt: 100,
    });

    expect(item.source).toBe('workflow_failure');
    expect(service.list({ sessionId: 'session-1' })[0]).toMatchObject({
      id: 'handoff:session-1:workflow:wf-1:failure',
      source: 'workflow_failure',
    });
  });

  it('updates accepted and dismissed status out of the pending list', () => {
    const item = service.create({
      sessionId: 'session-1',
      sourceMessageId: 'assistant-1',
      title: '继续验证',
      prompt: '继续验证。',
      createdAt: 100,
    });

    const accepted = service.updateStatus({
      id: item.id,
      status: 'accepted',
      updatedAt: 200,
    });

    expect(accepted?.status).toBe('accepted');
    expect(service.list({ sessionId: 'session-1' })).toEqual([]);
    expect(service.list({ sessionId: 'session-1', status: 'all' })[0]).toMatchObject({
      id: item.id,
      status: 'accepted',
      updatedAt: 200,
    });
  });
});
