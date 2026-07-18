// ============================================================================
// History tool tests (roadmap 2.1) — search + around over transcript_fts
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
const mockAround = vi.fn();
const mockDb = {
  isReady: true,
  searchTranscriptFts: mockSearch,
  getTranscriptAround: mockAround,
};

vi.mock('../../../src/host/services', () => ({
  getDatabase: () => mockDb,
}));

const { historyModule } = await import(
  '../../../src/host/tools/modules/lightMemory/history'
);

function makeCtx() {
  return {
    sessionId: 'sess-current',
    workingDir: '/tmp/proj',
    abortSignal: { aborted: false } as AbortSignal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(),
  } as unknown as Parameters<Awaited<ReturnType<typeof historyModule.createHandler>>['execute']>[1];
}

const canUseTool = vi.fn();

describe('History tool', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockAround.mockReset();
    canUseTool.mockReset();
    canUseTool.mockResolvedValue({ allow: true });
    mockDb.isReady = true;
  });

  // ---- validation -----------------------------------------------------------

  it('rejects unknown action', async () => {
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'noop' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('search requires a query of at least 3 chars', async () => {
    const handler = await historyModule.createHandler();
    const missing = await handler.execute({ action: 'search' }, makeCtx(), canUseTool);
    expect(missing.ok).toBe(false);
    const short = await handler.execute({ action: 'search', query: 'ab' }, makeCtx(), canUseTool);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/3 characters/);
  });

  it('around requires messageId', async () => {
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'around' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('rejects invalid kind values', async () => {
    const handler = await historyModule.createHandler();
    const result = await handler.execute(
      { action: 'search', query: 'deployment', kinds: ['user_text', 'bogus'] },
      makeCtx(),
      canUseTool
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  // ---- permission / infra ----------------------------------------------------

  it('honors permission denial', async () => {
    canUseTool.mockResolvedValue({ allow: false, reason: 'nope' });
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'search', query: 'deployment' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('fails gracefully when database is not ready', async () => {
    mockDb.isReady = false;
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'search', query: 'deployment' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DB_NOT_READY');
  });

  // ---- search ------------------------------------------------------------------

  it('passes filters through to the repository search', async () => {
    mockSearch.mockReturnValue([]);
    const handler = await historyModule.createHandler();
    await handler.execute(
      {
        action: 'search',
        query: 'deployment',
        kinds: ['tool_output'],
        tool_name: 'Bash',
        time_after: 1000,
        time_before: 2000,
        session_scope: 'current',
        limit: 7,
      },
      makeCtx(),
      canUseTool
    );
    expect(mockSearch).toHaveBeenCalledWith('deployment', {
      kinds: ['tool_output'],
      toolName: 'Bash',
      timeAfter: 1000,
      timeBefore: 2000,
      sessionId: 'sess-current',
      limit: 7,
    });
  });

  it('returns hits with messageId so the model can chain into around', async () => {
    mockSearch.mockReturnValue([
      {
        messageId: 'msg-42',
        sessionId: 'sess-old',
        kind: 'tool_output',
        toolName: 'Bash',
        snippet: '…fixed the «flaky» test…',
        timestamp: 1700000000000,
      },
    ]);
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'search', query: 'flaky test' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { total: number; hits: Array<Record<string, unknown>> };
      expect(out.total).toBe(1);
      expect(out.hits[0]).toMatchObject({
        messageId: 'msg-42',
        sessionId: 'sess-old',
        kind: 'tool_output',
        toolName: 'Bash',
      });
      expect(typeof out.hits[0].timestampIso).toBe('string');
    }
  });

  it('search returns ok with empty hits and a hint when nothing matches', async () => {
    mockSearch.mockReturnValue([]);
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'search', query: 'nothing here' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { total: number; hint?: string };
      expect(out.total).toBe(0);
      expect(out.hint).toBeTruthy();
    }
  });

  // ---- around --------------------------------------------------------------------

  it('around renders message context with roles, text and tool calls', async () => {
    mockAround.mockReturnValue({
      sessionId: 'sess-old',
      messages: [
        {
          matched: false,
          message: { id: 'm1', role: 'user', content: 'please fix the test', timestamp: 1000 },
        },
        {
          matched: true,
          message: {
            id: 'm2',
            role: 'assistant',
            content: 'on it',
            timestamp: 2000,
            thinking: 'the test is flaky because…',
            toolCalls: [
              {
                id: 'tc1',
                name: 'Bash',
                arguments: { command: 'npm test' },
                result: { toolCallId: 'tc1', success: true, output: '1 passed' },
              },
            ],
          },
        },
      ],
    });
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'around', message_id: 'm2' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as {
        sessionId: string;
        messages: Array<{ messageId: string; matched: boolean; role: string; toolCalls?: Array<{ name: string; output?: string }> }>;
      };
      expect(out.sessionId).toBe('sess-old');
      expect(out.messages.length).toBe(2);
      expect(out.messages[1].matched).toBe(true);
      expect(out.messages[1].toolCalls?.[0].name).toBe('Bash');
      expect(out.messages[1].toolCalls?.[0].output).toContain('1 passed');
    }
    expect(mockAround).toHaveBeenCalledWith('m2', { before: 5, after: 5 });
  });

  it('around clamps before/after to the max window', async () => {
    mockAround.mockReturnValue({ sessionId: 's', messages: [] });
    const handler = await historyModule.createHandler();
    await handler.execute({ action: 'around', message_id: 'm1', before: 500, after: 500 }, makeCtx(), canUseTool);
    const [, opts] = mockAround.mock.calls[0];
    expect(opts.before).toBeLessThanOrEqual(20);
    expect(opts.after).toBeLessThanOrEqual(20);
  });

  it('around reports unknown anchor as a normal (ok=false) error', async () => {
    mockAround.mockReturnValue(null);
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'around', message_id: 'ghost' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('around truncates oversized part text', async () => {
    mockAround.mockReturnValue({
      sessionId: 'sess-old',
      messages: [
        {
          matched: true,
          message: { id: 'm1', role: 'assistant', content: 'y'.repeat(10000), timestamp: 1000 },
        },
      ],
    });
    const handler = await historyModule.createHandler();
    const result = await handler.execute({ action: 'around', message_id: 'm1' }, makeCtx(), canUseTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { messages: Array<{ content?: string }> };
      expect((out.messages[0].content ?? '').length).toBeLessThan(10000);
    }
  });
});
