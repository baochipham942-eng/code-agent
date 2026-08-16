import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReadService } from '../../../../src/host/app/traceReadService';

function event(type: string, turnIndex: number, data: Record<string, unknown> = {}) {
  return { ts: turnIndex + 1, sessionId: 'session-a', turnIndex, type, data };
}

describe('TraceReadService', () => {
  let dataDir: string;
  let tracesDir: string;
  let service: TraceReadService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'code-agent-trace-read-'));
    tracesDir = join(dataDir, 'traces');
    await mkdir(tracesDir);
    service = new TraceReadService(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('distinguishes a missing ledger from an empty ledger', async () => {
    await writeFile(join(tracesDir, 'empty.jsonl'), '');

    await expect(service.readSession('missing')).resolves.toMatchObject({
      state: 'missing', events: [], skippedLines: 0, cursor: 0,
    });
    await expect(service.readSession('empty')).resolves.toMatchObject({
      state: 'empty', events: [], skippedLines: 0, cursor: 0,
    });
  });

  it('skips malformed lines loudly and passes unknown event types through', async () => {
    const unknown = event('future_event_from_p0a', 0, { future: true });
    await writeFile(join(tracesDir, 'session-a.jsonl'), `${JSON.stringify(unknown)}\n{bad json}\n`);

    await expect(service.readSession('session-a')).resolves.toMatchObject({
      state: 'present',
      events: [unknown],
      skippedLines: 1,
    });
  });

  it('keeps byte cursor continuity across incremental reads', async () => {
    const first = event('inference', 0, { inputTokens: 2, outputTokens: 1 });
    const second = event('loop_decision', 1);
    const file = join(tracesDir, 'session-a.jsonl');
    await writeFile(file, `${JSON.stringify(first)}\n`);

    const firstTail = await service.tailSession('session-a');
    await appendFile(file, `${JSON.stringify(second)}\n`);
    const secondTail = await service.tailSession('session-a', firstTail.cursor);
    const full = await service.readSession('session-a');

    expect([...firstTail.events, ...secondTail.events]).toEqual(full.events);
    expect(secondTail.cursor).toBe(full.cursor);
  });

  it('streams batch summaries without returning non-outcome events', async () => {
    const outcome = event('turn_outcome', 1, { terminal: 'completed', verdict: 'verified' });
    const lines = [
      event('inference', 0, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 }),
      event('future_event', 1),
      outcome,
    ];
    await writeFile(join(tracesDir, 'session-a.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\ninvalid\n`);
    await writeFile(join(tracesDir, 'empty.jsonl'), '');

    await expect(service.summarizeSessions(['session-a', 'empty', 'missing'])).resolves.toEqual([
      {
        sessionId: 'session-a',
        state: 'present',
        turnOutcomes: [outcome],
        tokenUsage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 },
        turnCount: 2,
        skippedLines: 1,
      },
      {
        sessionId: 'empty',
        state: 'empty',
        turnOutcomes: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        turnCount: 0,
        skippedLines: 0,
      },
      {
        sessionId: 'missing',
        state: 'missing',
        turnOutcomes: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        turnCount: 0,
        skippedLines: 0,
      },
    ]);
  });

  it('rejects traversal and cursors beyond the current file', async () => {
    await writeFile(join(tracesDir, 'session-a.jsonl'), `${JSON.stringify(event('inference', 0))}\n`);

    await expect(service.readSession('../escape')).rejects.toThrow('Invalid trace session id');
    await expect(service.tailSession('session-a', 999_999)).rejects.toThrow('beyond file size');
  });
});
