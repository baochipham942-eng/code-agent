import { describe, expect, it, vi } from 'vitest';
import { CronCloudRuntime } from '../../../src/host/cron/cronCloudRuntime';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';

function cloudJob(): CronJobDefinition {
  return {
    id: 'local-job-1',
    name: 'One-shot cloud job',
    runsOn: 'cloud',
    scheduleType: 'at',
    schedule: { type: 'at', datetime: 2_000_000 },
    action: { type: 'agent', agentType: 'default', prompt: 'Say hi.' },
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildRuntime(fetchImpl: typeof fetch) {
  const executions: CronJobExecution[] = [];
  const runtime = new CronCloudRuntime(
    () => ({ baseUrl: 'https://cron.example.test', token: 'secret-token' }),
    {
      getJobs: () => [{ definition: cloudJob(), cloudJobId: 'remote-1' }],
      persistJob: async () => {},
      persistExecution: async (execution) => { executions.push(execution); },
      loadExecutionStatus: () => undefined,
      onCompleted: async () => {},
      unavailableMessage: () => 'unavailable',
    },
    fetchImpl,
  );
  return { runtime, executions };
}

describe('CronCloudRuntime.removeJob', () => {
  // 一次性云端任务跑完后会被云端自动清掉。把「远端已经没有这条」当成删除失败，会让
  // cronService.deleteJob 直接返回 false，本地那条永远删不掉（2026-08-24 真机实付）。
  it('treats an already-gone remote job as removed', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/api/cron/list')) return jsonResponse({ ok: true, result: { jobs: [] } });
      return jsonResponse({ ok: false, error: 'gateway_error', detail: { message: 'id not found' } });
    });
    const { runtime, executions } = buildRuntime(fetchMock as typeof fetch);

    await expect(runtime.removeJob(cloudJob(), 'remote-1')).resolves.toBe(true);
    // 远端没有这条就不该再发 remove，更不该把它记成一次失败执行
    expect(calls).toEqual(['/api/cron/list']);
    expect(executions).toEqual([]);
  });

  it('removes the remote job when it is still there', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/api/cron/list')) {
        return jsonResponse({ ok: true, result: { jobs: [{ id: 'remote-1', declarationKey: 'neo:local-job-1' }] } });
      }
      return jsonResponse({ ok: true, result: {} });
    });
    const { runtime, executions } = buildRuntime(fetchMock as typeof fetch);

    await expect(runtime.removeJob(cloudJob(), undefined)).resolves.toBe(true);
    expect(calls).toEqual(['/api/cron/list', '/api/cron/remove']);
    expect(executions).toEqual([]);
  });

  it('reports a real removal failure instead of swallowing it', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/cron/list')) {
        return jsonResponse({ ok: true, result: { jobs: [{ id: 'remote-1' }] } });
      }
      return jsonResponse({ ok: false, error: 'gateway_unavailable' });
    });
    const { runtime, executions } = buildRuntime(fetchMock as typeof fetch);

    await expect(runtime.removeJob(cloudJob(), 'remote-1')).resolves.toBe(false);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe('failed');
  });
});
