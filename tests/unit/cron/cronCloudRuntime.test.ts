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

function buildRuntime(
  fetchImpl: typeof fetch,
  jobs: Array<{ definition: CronJobDefinition; cloudJobId?: string }> = [
    { definition: cloudJob(), cloudJobId: 'remote-1' },
  ],
) {
  const executions: CronJobExecution[] = [];
  const persisted: Array<{ jobId: string; cloudJobId: string }> = [];
  const runtime = new CronCloudRuntime(
    () => ({ baseUrl: 'https://cron.example.test', token: 'secret-token' }),
    {
      getJobs: () => jobs,
      persistJob: async (definition, cloudJobId) => { persisted.push({ jobId: definition.id, cloudJobId }); },
      persistExecution: async (execution) => { executions.push(execution); },
      loadExecutionStatus: () => undefined,
      onCompleted: async () => {},
      unavailableMessage: () => 'unavailable',
    },
    fetchImpl,
  );
  return { runtime, executions, persisted, jobs };
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


describe('CronCloudRuntime.reconcile', () => {
  // 云端把这条弄丢了（Pod 重建 / 手工清理）时，本地那条会永远停在 enabled 却再也不触发，
  // 无人值守场景没有任何信号。对账要能把它重新注册回去。
  it('re-registers a cloud job that no longer exists on the server', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/api/cron/list')) return jsonResponse({ ok: true, result: { jobs: [] } });
      return jsonResponse({ ok: true, result: { id: 'remote-2' } });
    });
    const future = { ...cloudJob(), schedule: { type: 'at' as const, datetime: Date.now() + 3_600_000 } };
    const { runtime, persisted, jobs } = buildRuntime(fetchMock as typeof fetch, [
      { definition: future, cloudJobId: 'remote-1' },
    ]);

    await runtime.reconcile();

    expect(calls).toEqual(['/api/cron/list', '/api/cron/add']);
    expect(jobs[0]?.cloudJobId).toBe('remote-2');
    expect(persisted).toEqual([{ jobId: 'local-job-1', cloudJobId: 'remote-2' }]);
  });

  // 幂等键还在、只是 id 变了：本地指针要对回去，否则后续 update / remove 全打空。
  it('repoints the local cloud job id when only the remote id changed', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return jsonResponse({ ok: true, result: { jobs: [{ id: 'remote-9', declarationKey: 'neo:local-job-1' }] } });
    });
    const future = { ...cloudJob(), schedule: { type: 'at' as const, datetime: Date.now() + 3_600_000 } };
    const { runtime, persisted, jobs } = buildRuntime(fetchMock as typeof fetch, [
      { definition: future, cloudJobId: 'remote-1' },
    ]);

    await runtime.reconcile();

    expect(calls).toEqual(['/api/cron/list']);
    expect(jobs[0]?.cloudJobId).toBe('remote-9');
    expect(persisted).toEqual([{ jobId: 'local-job-1', cloudJobId: 'remote-9' }]);
  });

  // 一次性任务跑完云端会自动清除——那正是「远端没有这条」的正常形态。把它当丢失重新注册
  // 会让一条过期任务被反复复活、每分钟再跑一遍。
  it('does not resurrect a one-shot job whose fire time has passed', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      calls.push(new URL(String(url)).pathname);
      return jsonResponse({ ok: true, result: { jobs: [] } });
    });
    const { runtime } = buildRuntime(fetchMock as typeof fetch);

    await runtime.reconcile();

    expect(calls).toEqual(['/api/cron/list']);
  });

  // 拉不到清单是瞬时不可用，不是「云端丢了这条」——不许每轮给每条任务记一次失败刷屏。
  it('skips the round without recording failures when the list call fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: 'gateway_unavailable' }));
    const future = { ...cloudJob(), schedule: { type: 'at' as const, datetime: Date.now() + 3_600_000 } };
    const { runtime, executions } = buildRuntime(fetchMock as typeof fetch, [
      { definition: future, cloudJobId: 'remote-1' },
    ]);

    await runtime.reconcile();

    expect(executions).toEqual([]);
  });

  // 装好没接电防线：对账逻辑写对了但没人按周期调它，等于启动那一次之后再无对账。
  it('runs reconcile on a timer while started', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({ ok: true, result: { jobs: [{ id: 'remote-1' }] } });
      });
      const future = { ...cloudJob(), schedule: { type: 'at' as const, datetime: Date.now() + 3_600_000 } };
      const { runtime } = buildRuntime(fetchMock as typeof fetch, [
        { definition: future, cloudJobId: 'remote-1' },
      ]);

      runtime.start();
      await vi.advanceTimersByTimeAsync(60_000);
      runtime.stop();
      const afterStop = calls.filter((path) => path.endsWith('/api/cron/list')).length;
      await vi.advanceTimersByTimeAsync(180_000);

      expect(afterStop).toBeGreaterThanOrEqual(1);
      expect(calls.filter((path) => path.endsWith('/api/cron/list')).length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
