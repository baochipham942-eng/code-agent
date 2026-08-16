import express from 'express';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceReadService } from '../../../src/host/app/traceReadService';
import { createSessionsRouter } from '../../../src/web/routes/sessions';

describe('session trace routes', () => {
  let dataDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'code-agent-trace-routes-'));
    await mkdir(join(dataDir, 'traces'));
    const service = new TraceReadService(dataDir);
    const app = express();
    app.use(express.json());
    app.use('/api', createSessionsRouter({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
      getTraceReadService: () => service,
    }));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves full, tail, and batch summary reads', async () => {
    const inference = {
      ts: 1,
      sessionId: 'route-session',
      turnIndex: 0,
      type: 'inference',
      data: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 8 },
    };
    const outcome = {
      ts: 2,
      sessionId: 'route-session',
      turnIndex: 0,
      type: 'turn_outcome',
      data: { terminal: 'completed', verdict: 'verified' },
    };
    await writeFile(
      join(dataDir, 'traces', 'route-session.jsonl'),
      `${JSON.stringify(inference)}\n${JSON.stringify(outcome)}\n`,
    );

    const fullResponse = await fetch(`${baseUrl}/api/sessions/route-session/trace`);
    const full = await fullResponse.json() as { success: boolean; data: { events: unknown[]; cursor: number } };
    expect(fullResponse.status).toBe(200);
    expect(full).toMatchObject({ success: true, data: { state: 'present', events: [inference, outcome] } });

    const tailResponse = await fetch(`${baseUrl}/api/sessions/route-session/trace/tail?cursor=${full.data.cursor}`);
    await expect(tailResponse.json()).resolves.toMatchObject({
      success: true,
      data: { state: 'present', events: [], cursor: full.data.cursor },
    });

    const summaryResponse = await fetch(`${baseUrl}/api/sessions/traces/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['route-session', 'missing'] }),
    });
    await expect(summaryResponse.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          sessionId: 'route-session',
          state: 'present',
          turnOutcomes: [outcome],
          tokenUsage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 8 },
          turnCount: 1,
          skippedLines: 0,
        },
        { sessionId: 'missing', state: 'missing' },
      ],
    });
  });

  it('rejects invalid cursors and batch bodies', async () => {
    const cursorResponse = await fetch(`${baseUrl}/api/sessions/safe/trace/tail?cursor=-1`);
    expect(cursorResponse.status).toBe(400);

    const batchResponse = await fetch(`${baseUrl}/api/sessions/traces/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: 'route-session' }),
    });
    expect(batchResponse.status).toBe(400);
  });
});
