// ============================================================================
// LogBridge Task Status Routes Integration（P3-A）
// ============================================================================
// 真实启 HTTP server，注入 fake provider，curl /tasks /task-status /projects，
// 验证只读路由端到端可用 + 缺参 400 + 未找到 404。
// 单一生命周期（beforeAll start / afterAll stop），避免反复 start/stop 抢占端口的 race。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logBridge, type TaskStatusBridgeProvider } from '../../../src/main/mcp/logBridge';
import { PORTS } from '../../../src/shared/constants/index';

const BASE = `http://127.0.0.1:${PORTS.logBridge}`;

const fakeProvider: TaskStatusBridgeProvider = {
  listTasks: (opts) => ({ swarmRuns: [{ id: 'run-1', limit: opts.limit ?? null }], liveSessions: [{ sessionId: 's1', status: 'running' }] }),
  getTaskStatus: (runId) => (runId === 'run-1' ? { id: 'run-1', status: 'completed', eventSummary: { total: 2 } } : null),
  listProjects: (opts) => [{ id: 'p1', name: 'Proj', archived: opts.includeArchived ?? false }],
};

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('LogBridge P3-A read-only task routes', () => {
  beforeAll(async () => {
    logBridge.setTaskStatusProvider(fakeProvider);
    await logBridge.start();
  });

  afterAll(async () => {
    await logBridge.stop();
  });

  it('/tasks 返回 swarmRuns + liveSessions，limit 透传', async () => {
    const r = await getJson('/tasks?limit=7');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      swarmRuns: [{ id: 'run-1', limit: 7 }],
      liveSessions: [{ sessionId: 's1', status: 'running' }],
    });
  });

  it('/task-status?id=run-1 命中返回详情；缺 id → 400；未找到 → 404', async () => {
    const hit = await getJson('/task-status?id=run-1');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ id: 'run-1', status: 'completed' });

    const missing = await getJson('/task-status');
    expect(missing.status).toBe(400);

    const notFound = await getJson('/task-status?id=nope');
    expect(notFound.status).toBe(404);
  });

  it('/projects 返回项目列表，includeArchived 透传', async () => {
    const def = await getJson('/projects');
    expect(def.status).toBe(200);
    expect(def.body).toMatchObject([{ id: 'p1', archived: false }]);

    const arch = await getJson('/projects?includeArchived=true');
    expect(arch.body).toMatchObject([{ id: 'p1', archived: true }]);
  });
});
