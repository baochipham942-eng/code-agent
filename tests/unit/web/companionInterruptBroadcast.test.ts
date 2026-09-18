// ============================================================================
// 手机插话的桌面广播（ai-review R8 Nit 3）
// ============================================================================
// 手机 message.send 打进一条在跑的 run 时，dispatch 必须与桌面 /api/interrupt
// 广播同一套 interrupt_start / interrupt_complete agent:event——否则电脑聊天区
// 在刷新前看不到这条用户消息。这里挂真实 createApp（companion 分支用真
// in-memory SQLite），从 /companion/commands 走完整协议路径钉住广播。
// ============================================================================
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const mockBroadcastSSE = vi.hoisted(() => vi.fn());
const companionDb = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));

vi.mock('../../../src/web/helpers/sse', async () => {
  const actual = await vi.importActual<typeof import('../../../src/web/helpers/sse')>('../../../src/web/helpers/sse');
  return {
    ...actual,
    broadcastSSE: mockBroadcastSSE,
  };
});

// createApp 的 companion 分支只在 getDatabase().getDb() 非空时接线：
// 给它一个真 in-memory SQLite，让 CompanionGateway 在上面建表；getSession
// 供 submit 的 session 可见性检查（scope 命中即放行）。
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => companionDb.db,
    getSession: () => ({ id: 'interrupt-session', title: 'Interrupt session', projectId: null }),
  }),
}));

import { createApp, type CreateAppDeps } from '../../../src/web/app';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';

const sessionId = 'interrupt-session';

describe('phone message.send broadcasts desktop interrupt events', () => {
  let server: http.Server | undefined;
  let baseUrl = '';
  let dataDir = '';
  const runRegistry = new RunRegistry();
  const mockCancel = vi.fn();
  const mockSteer = vi.fn(async () => {});

  beforeEach(async () => {
    companionDb.db = new Database(':memory:');
    mockBroadcastSSE.mockClear();
    dataDir = await mkdtemp(join(tmpdir(), 'companion-interrupt-'));
    const deps: CreateAppDeps = {
      handlers: new Map(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runRegistry,
      pendingLocalToolCalls: new Map(),
      pendingDevPermissions: new Map(),
      resolveCodeAgentDataDir: () => dataDir,
      getAppVersion: () => '0.0.0-test',
      getBuildInfo: () => null,
      getDurableRunRollout: () => ({
        policy: { mode: 'legacy', configuredValue: null, valid: true, durableActivation: false, durableReadPreference: false },
        ready: false,
      }),
      getDurableRunReadService: () => undefined,
      internalFeatures: {
        runtime: { isLoaded: () => false, loadedHash: () => undefined },
        registry: { getPlugin: () => undefined },
        pluginsDir: `${dataDir}/plugins`,
      },
    };
    const app = createApp(deps);
    // 配对设备直接落库（credential_hash 与 gateway 的 sha256 摘要同款），
    // 不走邀请配对流程——这里钉的是 dispatch 广播，不是配对。
    companionDb.db!.prepare(
      `INSERT INTO companion_devices (device_id, credential_hash, scope_json, scope_epoch, revoked_at, created_at)
       VALUES (?, ?, ?, 1, NULL, 0)`,
    ).run('phone', createHash('sha256').update('test-credential').digest('hex'), JSON.stringify([sessionId]));
    server = http.createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()));
    companionDb.db?.close();
    companionDb.db = null;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('steering an active run from the phone emits interrupt_start then interrupt_complete to the desktop', async () => {
    const handle = runRegistry.start({ runId: 'run-interrupt', sessionId, workspace: process.cwd() });
    await handle.attach({ cancel: mockCancel, steer: mockSteer });

    const response = await fetch(`${baseUrl}/companion/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-neo-companion-device': 'phone',
        'x-neo-companion-credential': 'test-credential',
      },
      body: JSON.stringify({
        version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'cmd-interrupt-1', sessionId,
        action: 'message.send', payload: { text: '手机插一句：先别删' },
      }),
    });
    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      expect(mockBroadcastSSE.mock.calls.map(([channel, event]) => `${channel}:${(event as { type: string }).type}`))
        .toEqual(['agent:event:interrupt_start', 'agent:event:interrupt_complete']);
    });
    const [, startEvent] = mockBroadcastSSE.mock.calls[0];
    const [, completeEvent] = mockBroadcastSSE.mock.calls[1];
    expect(startEvent).toEqual({
      type: 'interrupt_start',
      data: { message: '正在调整方向...', newUserMessage: '手机插一句：先别删', runId: 'run-interrupt' },
      sessionId,
    });
    expect(completeEvent).toEqual({
      type: 'interrupt_complete',
      data: { message: '已调整方向', newUserMessage: '手机插一句：先别删', runId: 'run-interrupt' },
      sessionId,
    });
    // steer 收到的就是手机这条原文，clientMessageId 用 commandId（与手机 live publish 同 id）。
    expect(mockSteer).toHaveBeenCalledWith('手机插一句：先别删', 'cmd-interrupt-1', undefined,
      { workbench: { runtimeInputMode: 'supplement' } }, undefined, undefined);
    await handle.cancel('user');
  });
});
