// ============================================================================
// EpisodicRecall tool tests (Workstream D)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
const mockDb = {
  isReady: true,
  searchSessionMessagesFts: mockSearch,
};

vi.mock('../../../src/main/services', () => ({
  getDatabase: () => mockDb,
}));

const { episodicRecallModule } = await import(
  '../../../src/main/tools/modules/lightMemory/episodicRecall'
);

function makeCtx() {
  return {
    sessionId: 'sess-current',
    workingDir: '/tmp/proj',
    abortSignal: { aborted: false } as AbortSignal,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    emit: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof episodicRecallModule.createHandler>['execute']>[1];
}

const canUseTool = vi.fn().mockResolvedValue({ allow: true });

describe('EpisodicRecall tool', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    canUseTool.mockReset();
    canUseTool.mockResolvedValue({ allow: true });
    mockDb.isReady = true;
  });

  it('rejects empty query', async () => {
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: '' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('rejects query shorter than 3 characters', async () => {
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: 'ab' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toMatch(/3 characters/);
    }
  });

  it('rejects query longer than 200 chars', async () => {
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: 'x'.repeat(201) }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('passes sessionId scope=current to repository', async () => {
    mockSearch.mockReturnValue([]);
    const handler = await episodicRecallModule.createHandler();
    await handler.execute(
      { query: 'deployment', session_scope: 'current' },
      makeCtx(),
      canUseTool,
    );
    expect(mockSearch).toHaveBeenCalledWith('deployment', {
      limit: 5,
      sessionId: 'sess-current',
    });
  });

  it('default scope=all does not pass sessionId', async () => {
    mockSearch.mockReturnValue([]);
    const handler = await episodicRecallModule.createHandler();
    await handler.execute({ query: 'deployment' }, makeCtx(), canUseTool);
    expect(mockSearch).toHaveBeenCalledWith('deployment', {
      limit: 5,
      sessionId: undefined,
    });
  });

  it('clamps limit to max 10', async () => {
    mockSearch.mockReturnValue([]);
    const handler = await episodicRecallModule.createHandler();
    await handler.execute({ query: 'deployment', limit: 999 }, makeCtx(), canUseTool);
    expect(mockSearch).toHaveBeenCalledWith('deployment', expect.objectContaining({ limit: 10 }));
  });

  it('returns truncated snippets with ISO timestamp', async () => {
    mockSearch.mockReturnValue([
      {
        messageId: 'm1',
        sessionId: 'sess-A',
        role: 'user',
        content: 'x'.repeat(500),
        timestamp: 1_700_000_000_000,
      },
    ]);
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: 'deployment' }, makeCtx(), canUseTool);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.output.total).toBe(1);
    // EPISODIC_SNIPPET_MAX_CHARS = 300; snippet must be truncated + '…'
    expect(result.output.snippets[0].snippet.length).toBeLessThanOrEqual(301);
    expect(result.output.snippets[0].snippet.endsWith('…')).toBe(true);
    expect(result.output.snippets[0].timestampIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fails gracefully if DB is not ready', async () => {
    mockDb.isReady = false;
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: 'deployment' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DB_NOT_READY');
    mockDb.isReady = true;
  });

  it('respects permission denial', async () => {
    canUseTool.mockResolvedValue({ allow: false, reason: 'plan mode' });
    const handler = await episodicRecallModule.createHandler();
    const result = await handler.execute({ query: 'deployment' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });
});
