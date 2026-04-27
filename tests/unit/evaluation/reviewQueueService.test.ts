import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
  getSession: vi.fn(),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../../src/main/services/core/databaseService';
import { ReviewQueueService } from '../../../../src/main/evaluation/reviewQueueService';

describe('ReviewQueueService', () => {
  let service: ReviewQueueService;
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let originalGetSession: typeof database.getSession;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.getSession.mockReset();
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    originalGetSession = database.getSession.bind(database);
    database.getDb = () => dbState.sqlite;
    database.getSession = dbState.getSession as typeof database.getSession;
    service = new ReviewQueueService();
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    database.getSession = originalGetSession;
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('creates a stable review item identity from session trace and resolves title from repository', () => {
    dbState.getSession.mockReturnValue({
      id: 'session-1',
      title: 'Resolved Session Title',
    });

    const item = service.enqueueSession({
      sessionId: 'session-1',
      sessionTitle: 'Fallback Title',
      reason: 'manual_review',
      enqueueSource: 'current_session_bar',
    });

    expect(item.id).toBe('review:session:session-1');
    expect(item.trace).toEqual({
      traceId: 'session:session-1',
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId: 'session-1',
      replayKey: 'session-1',
    });
    expect(item.enqueueSource).toBe('current_session_bar');
    expect(item.sessionTitle).toBe('Resolved Session Title');
    expect(service.listItems()).toHaveLength(1);
  });

  it('upserts the same session review item instead of creating duplicates', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);

    dbState.getSession.mockReturnValue(null);

    const first = service.enqueueSession({
      sessionId: 'session-2',
      sessionTitle: 'First Title',
      reason: 'manual_review',
      enqueueSource: 'current_session_bar',
    });

    const second = service.enqueueSession({
      sessionId: 'session-2',
      sessionTitle: 'Updated Title',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'prompt_policy',
        category: 'loop',
        summary: 'Repeated the same recovery action.',
        stepIndex: 4,
        confidence: 0.74,
        evidence: [4, 5],
      },
    });

    const items = service.listItems();

    expect(items).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.sessionTitle).toBe('Updated Title');
    expect(second.reason).toBe('failure_followup');
    expect(second.enqueueSource).toBe('replay_failure');
    expect(second.source).toBe('replay_failure');
    expect(second.failureCapability).toEqual({
      sink: 'prompt_policy',
      category: 'loop',
      summary: 'Repeated the same recovery action.',
      stepIndex: 4,
      confidence: 0.74,
      evidence: [4, 5],
    });
    expect(second.failureAsset).toMatchObject({
      id: 'failure-asset:review:session:session-2',
      reviewItemId: 'review:session:session-2',
      sessionId: 'session-2',
      traceId: 'session:session-2',
      status: 'draft',
      sink: 'prompt_policy',
      category: 'loop',
      title: 'Prompt Policy · 循环卡住 draft',
      body: [
        'Repeated the same recovery action.',
        'Target: Prompt Policy',
        'Category: 循环卡住',
        'Root step: 4',
        'Confidence: 74%',
        'Evidence steps: 4, 5',
      ].join('\n'),
      stepIndex: 4,
      confidence: 0.74,
      evidence: [4, 5],
    });

    nowSpy.mockRestore();
  });

  it('falls back to a derived title when neither repository nor payload provides one', () => {
    dbState.getSession.mockReturnValue(null);

    const item = service.enqueueSession({
      sessionId: 'abcdef123456',
    });

    expect(item.sessionTitle).toBe('Session abcdef12');
  });

  it('keeps persisted review queue items after reopening the database file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-queue-'));
    const dbPath = path.join(tempDir, 'review-queue.sqlite');

    dbState.sqlite?.close();
    dbState.sqlite = new Database(dbPath);
    dbState.getSession.mockReturnValue(null);

    const firstService = new ReviewQueueService();
    firstService.enqueueSession({
      sessionId: 'persisted-session',
      sessionTitle: 'Persisted Review Session',
      reason: 'manual_review',
      enqueueSource: 'session_list',
    });

    dbState.sqlite.close();
    dbState.sqlite = new Database(dbPath);

    const reopenedService = new ReviewQueueService();
    const items = reopenedService.listItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'review:session:persisted-session',
      sessionId: 'persisted-session',
      sessionTitle: 'Persisted Review Session',
      reason: 'manual_review',
      enqueueSource: 'session_list',
      source: 'session_list',
      trace: {
        traceId: 'session:persisted-session',
        traceSource: 'session_replay',
        source: 'session_replay',
        sessionId: 'persisted-session',
        replayKey: 'persisted-session',
      },
    });

    dbState.sqlite.close();
    dbState.sqlite = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists failure capability metadata with replay failure follow-up items', () => {
    dbState.getSession.mockReturnValue(null);

    service.enqueueSession({
      sessionId: 'session-with-routing',
      sessionTitle: 'Failure Routing Session',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'dataset',
        category: 'missing_context',
        summary: 'Important context was missing from the replay.',
        stepIndex: 2,
        confidence: 0.91,
        evidence: [2, 3],
      },
    });

    const items = service.listItems();

    expect(items[0]).toMatchObject({
      sessionId: 'session-with-routing',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      source: 'replay_failure',
      failureCapability: {
        sink: 'dataset',
        category: 'missing_context',
        summary: 'Important context was missing from the replay.',
        stepIndex: 2,
        confidence: 0.91,
        evidence: [2, 3],
      },
      failureAsset: {
        id: 'failure-asset:review:session:session-with-routing',
        reviewItemId: 'review:session:session-with-routing',
        sessionId: 'session-with-routing',
        traceId: 'session:session-with-routing',
        status: 'draft',
        sink: 'dataset',
        category: 'missing_context',
        title: 'Dataset · 缺少上下文 draft',
        body: [
          'Important context was missing from the replay.',
          'Target: Dataset',
          'Category: 缺少上下文',
          'Root step: 2',
          'Confidence: 91%',
          'Evidence steps: 2, 3',
        ].join('\n'),
        stepIndex: 2,
        confidence: 0.91,
        evidence: [2, 3],
      },
    });
  });

  it('keeps failure asset drafts after reopening the database file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-queue-assets-'));
    const dbPath = path.join(tempDir, 'review-queue.sqlite');

    dbState.sqlite?.close();
    dbState.sqlite = new Database(dbPath);
    dbState.getSession.mockReturnValue(null);

    const firstService = new ReviewQueueService();
    firstService.enqueueSession({
      sessionId: 'persisted-failure-session',
      sessionTitle: 'Persisted Failure Session',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      source: 'replay_failure',
      failureCapability: {
        sink: 'capability_health',
        category: 'tool_error',
        summary: 'Tool call failed during replay.',
        stepIndex: 6,
        confidence: 0.67,
        evidence: [6],
      },
    });

    dbState.sqlite.close();
    dbState.sqlite = new Database(dbPath);

    const reopenedService = new ReviewQueueService();
    const items = reopenedService.listItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'review:session:persisted-failure-session',
      sessionId: 'persisted-failure-session',
      sessionTitle: 'Persisted Failure Session',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'capability_health',
        category: 'tool_error',
        summary: 'Tool call failed during replay.',
        stepIndex: 6,
        confidence: 0.67,
        evidence: [6],
      },
      failureAsset: {
        id: 'failure-asset:review:session:persisted-failure-session',
        reviewItemId: 'review:session:persisted-failure-session',
        sessionId: 'persisted-failure-session',
        traceId: 'session:persisted-failure-session',
        status: 'draft',
        sink: 'capability_health',
        category: 'tool_error',
        title: 'Capability Health · 工具失败 draft',
        body: [
          'Tool call failed during replay.',
          'Target: Capability Health',
          'Category: 工具失败',
          'Root step: 6',
          'Confidence: 67%',
          'Evidence steps: 6',
        ].join('\n'),
        stepIndex: 6,
        confidence: 0.67,
        evidence: [6],
      },
    });

    dbState.sqlite.close();
    dbState.sqlite = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates failure asset status and bumps the review item updated time', () => {
    dbState.getSession.mockReturnValue(null);

    service.enqueueSession({
      sessionId: 'status-session',
      sessionTitle: 'Status Session',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: {
        sink: 'skill',
        category: 'bad_decision',
        summary: 'Wrong plan selected.',
        stepIndex: 1,
        confidence: 0.8,
        evidence: [1],
      },
    });

    const updated = service.updateFailureAssetStatus({
      reviewItemId: 'review:session:status-session',
      status: 'ready',
      updatedAt: 9_999,
    });

    expect(updated).toMatchObject({
      id: 'review:session:status-session',
      updatedAt: 9_999,
      failureAsset: {
        status: 'ready',
        updatedAt: 9_999,
      },
    });
    expect(service.listItems()[0]).toMatchObject({
      id: 'review:session:status-session',
      updatedAt: 9_999,
      failureAsset: {
        status: 'ready',
        updatedAt: 9_999,
      },
    });
  });

  it('returns null when updating a missing failure asset', () => {
    expect(service.updateFailureAssetStatus({
      reviewItemId: 'review:session:missing',
      status: 'dismissed',
      updatedAt: 123,
    })).toBeNull();
  });
});
