import { describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import {
  buildCronApiAddParams,
  buildCronApiUpdateParams,
  CronApiClient,
} from '../../../src/host/cron/cronApiClient';

function cloudJob(): CronJobDefinition {
  return {
    id: 'local-job-1',
    name: 'Cloud digest',
    description: 'Summarize the queue',
    runsOn: 'cloud',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 2, unit: 'hours', startAt: 1_800_000 },
    action: { type: 'agent', agentType: 'default', prompt: 'Summarize the queue.' },
    enabled: true,
    timeout: 120_000,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('CronApiClient request contract', () => {
  it('passes the constructed add params through without injecting extra fields', async () => {
    const job = cloudJob();
    const expected = {
      declarationKey: 'neo:local-job-1',
      name: 'Cloud digest',
      description: 'Summarize the queue',
      enabled: true,
      schedule: { kind: 'every', everyMs: 7_200_000, anchorMs: 1_800_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'Summarize the queue.', timeoutSeconds: 120 },
      delivery: { mode: 'none' },
    };
    expect(buildCronApiAddParams(job)).toEqual(expected);
    expect(buildCronApiUpdateParams(job, 'remote-1')).toEqual({
      id: 'remote-1',
      patch: Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'declarationKey')),
    });

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(expected);
      return new Response(JSON.stringify({ ok: true, result: { id: 'remote-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new CronApiClient(
      () => ({ baseUrl: 'https://cron.example.test/', token: 'secret-token' }),
      fetchMock as typeof fetch,
    );

    await expect(client.addJob(buildCronApiAddParams(job))).resolves.toBe('remote-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('CronApiClient event recovery', () => {
  it('backfills runs before opening the SSE stream on initial connect and reconnect', async () => {
    const requestPaths: string[] = [];
    let cycle = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/runs')) {
        cycle += 1;
        return new Response(JSON.stringify({
          ok: true,
          result: {
            entries: [{
              jobId: 'remote-1',
              action: 'finished',
              ts: cycle,
              runId: `missed-${cycle}`,
              status: 'ok',
            }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(
        `event: cron\ndata: ${JSON.stringify({
          jobId: 'remote-1',
          action: 'finished',
          ts: cycle,
          runId: `live-${cycle}`,
          status: 'ok',
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const client = new CronApiClient(
      () => ({ baseUrl: 'https://cron.example.test', token: 'secret-token' }),
      fetchMock as typeof fetch,
    );
    const seen: string[] = [];

    await client.connectOnce((run) => { if (run.runId) seen.push(run.runId); });
    await client.connectOnce((run) => { if (run.runId) seen.push(run.runId); });

    expect(requestPaths).toEqual([
      '/api/cron/runs?scope=all',
      '/api/cron/events',
      '/api/cron/runs?scope=all',
      '/api/cron/events',
    ]);
    expect(seen).toEqual(['missed-1', 'live-1', 'missed-2', 'live-2']);
  });
});
