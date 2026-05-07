import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { PreviewFeedbackService } from '../../../src/main/evaluation/previewFeedbackService';

describe('PreviewFeedbackService', () => {
  let service: PreviewFeedbackService;
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    database.getDb = () => dbState.sqlite;
    service = new PreviewFeedbackService();
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('creates, lists, and updates preview feedback', () => {
    const item = service.create({
      sessionId: 'session-1',
      previewItemId: 'artifact-1',
      note: 'Button overflows on mobile.',
      anchor: {
        kind: 'text_quote',
        quote: 'width: 1440px',
        filePath: '/tmp/app.html',
      },
      issueCode: 'layout_overflow',
      createdAt: 1_000,
    });

    expect(item).toMatchObject({
      id: 'preview-feedback:session-1:artifact-1:layout_overflow',
      status: 'open',
      source: 'user',
      issueCode: 'layout_overflow',
    });
    expect(service.list({ sessionId: 'session-1', previewItemId: 'artifact-1' })).toHaveLength(1);

    const updated = service.updateStatus({
      id: item.id,
      status: 'resolved',
      updatedAt: 2_000,
    });

    expect(updated).toMatchObject({
      id: item.id,
      status: 'resolved',
      updatedAt: 2_000,
    });
  });

  it('turns open feedback into chat context', () => {
    service.create({
      sessionId: 'session-2',
      previewItemId: 'artifact-2',
      note: 'Missing evidence for the claim.',
      issueCode: 'missing_evidence',
      anchor: { kind: 'artifact', filePath: '/tmp/report.md' },
      createdAt: 1_000,
    });

    const context = service.buildChatContext({
      sessionId: 'session-2',
      previewItemId: 'artifact-2',
    });

    expect(context.items).toHaveLength(1);
    expect(context.message).toContain('Preview feedback');
    expect(context.message).toContain('missing_evidence');
    expect(context.message).toContain('/tmp/report.md');
  });
});
