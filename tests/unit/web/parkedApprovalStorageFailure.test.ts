// ============================================================================
// 停车审批：台账瞬时写失败必须仍然可裁决
// ----------------------------------------------------------------------------
// 病灶：`resolveParkedApproval` 的 repo 写失败与「宿主没有这条请求」共用一个
// `'unknown_request'`。web 投递层据此调 `closeDeadParkedApproval`，把行强改成
// rejected 并写下 'owning run is no longer alive' —— 而 run 明明还活着、内存里的
// Promise 也还挂着。用户再点，`repo.resolve` 匹配 0 行，从此恒 unknown_request：
// **这个审批永久不可裁决**，而基线行为下重试本来能救回来。
//
// 不变量：瞬时存储错误不得被翻译成用户意图的终态否决，也不得写下与事实相反的理由。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

const mocks = vi.hoisted(() => ({
  closeDeadParkedApproval: vi.fn((_requestId: string) => false),
  handle: vi.fn((_sessionId: string, _requestId: string, _response: string): string => 'no_orchestrator'),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/agent/parkedApprovalHydration', () => ({
  closeDeadParkedApproval: mocks.closeDeadParkedApproval,
}));
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ handlePermissionResponse: mocks.handle }),
}));

import Database from 'better-sqlite3';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import type { PermissionResponse } from '../../../src/shared/contract/permission';

type DeliverResult = { success: boolean; error?: { code: string }; data?: { closed?: boolean } };

describe('parked approval survives a transient ledger write failure', () => {
  let db: Database.Database;
  let island: OrchestratorPermissionIsland;
  let deliver: (requestId: string, response: PermissionResponse, sessionId: string) => DeliverResult;
  const sessionId = 'unattended-session';
  const row = (id: string) =>
    db.prepare('SELECT status, feedback FROM pending_approvals WHERE id = ?').get(id) as { status: string; feedback: string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    // 让替身做真身做的那件事：把仍 pending 的行强改 rejected + 写下那句假理由。
    // 只断言「没被调用」会漏掉真正的伤害，断言台账内容才看得见账本被写反。
    mocks.closeDeadParkedApproval.mockImplementation((requestId: string) => {
      // BUSY 是瞬时的：等收口这一手伸过来时窗口往往已经关了，所以它写得进去——
      // 那正是伤害落地的时刻，也是这条测试要盯住的那一刻。
      db.exec('DROP TRIGGER IF EXISTS fail_resolve');
      return db.prepare("UPDATE pending_approvals SET status='rejected', feedback=?, resolved_at=? WHERE id=? AND status='pending'")
        .run('Auto-rejected: owning run is no longer alive', Date.now(), requestId).changes > 0;
    });
    db = new Database(':memory:');
    db.exec('CREATE TABLE pending_approvals (id TEXT PRIMARY KEY,kind TEXT,agent_id TEXT,agent_name TEXT,coordinator_id TEXT,payload_json TEXT,status TEXT,submitted_at INTEGER,resolved_at INTEGER,feedback TEXT)');
    island = new OrchestratorPermissionIsland({
      getSettings: () => DEFAULT_SETTINGS,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: () => {},
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
    });
    mocks.handle.mockImplementation((_s, id, response) => island.handlePermissionResponse(id, response as PermissionResponse));
    deliver = installPermissionResponseHandler({
      handlers: new Map(), pendingDevPermissions: new Map(),
      getCurrentSessionId: () => sessionId, logger: { info: () => {}, warn: () => {} },
    }) as typeof deliver;
  });
  afterEach(() => { island.drainPendingPermissions(); db.close(); });

  function park() {
    const promise = island.requestPermission({
      type: 'directory_access', tool: 'request_directory', sessionId,
      details: { path: '/tmp/neo-parked-retry' },
    });
    return { promise, id: island.listPendingRequests()[0].id };
  }

  it('写失败时台账不被改成 rejected、不被收口，重试能真正裁决', async () => {
    const { promise, id } = park();
    expect(row(id).status).toBe('pending');

    // 瞬时 SQLITE_BUSY 的等价物：这一次 UPDATE 必然抛错
    db.exec("CREATE TRIGGER fail_resolve BEFORE UPDATE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY injected'); END");
    const failed = deliver(id, 'allow', sessionId);

    // ① 台账原样留着——没被翻成 rejected，也没被写上「run 已经不在了」这种假理由
    expect(row(id)).toEqual({ status: 'pending', feedback: null });
    // ② 收口那只手根本没伸过来（它才是把「允许」变成永久 rejected 的动作）
    expect(mocks.closeDeadParkedApproval).not.toHaveBeenCalled();
    // ③ 回给调用方的是可重试的失败，不是带 closed:true 的假成功
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('PENDING_APPROVAL_STORAGE_UNAVAILABLE');
    // ④ 内存里的审批还挂着，run 仍在等它
    expect(island.listPendingRequests().map(request => request.id)).toEqual([id]);

    db.exec('DROP TRIGGER fail_resolve');
    expect(deliver(id, 'allow', sessionId).success).toBe(true);
    expect(row(id).status).toBe('approved');
    await expect(promise).resolves.toMatchObject({ approved: true });
  });

  it('真的失去宿主时照旧收口——修的是误判，不是把收口关掉', () => {
    mocks.handle.mockImplementation(() => 'unknown_request');
    mocks.closeDeadParkedApproval.mockReturnValue(true);
    const result = deliver('request-from-a-dead-process', 'allow', sessionId);
    expect(mocks.closeDeadParkedApproval).toHaveBeenCalledWith('request-from-a-dead-process');
    expect(result.data?.closed).toBe(true);
  });
});
