import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../src/host/task/TaskManager', () => ({ getTaskManager: () => ({ handlePermissionResponse: () => 'unknown_request' }) }));
vi.mock('../../src/host/agent/parkedApprovalHydration', () => ({ closeDeadParkedApproval: () => false }));
import Database from 'better-sqlite3';
import { PendingApprovalRepository } from '../../src/host/services/core/repositories/PendingApprovalRepository';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionApprovalService } from '../../src/host/services/companion/CompanionApprovalService';
import { OrchestratorPermissionIsland } from '../../src/host/agent/orchestratorPermissions';
import { registerForegroundPermissionIsland, unregisterForegroundPermissionIsland, listForegroundPermissionRequests } from '../../src/web/foregroundPermissionRegistry';
import { installPermissionResponseHandler } from '../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS } from '../../src/host/services/core/configDefaults';
import { COMPANION_LIMITS } from '../../src/shared/constants/companion';
import { EDITABLE_PERMISSION_TIMEOUT_MS } from '../../src/shared/contract/permissionEdit';
import type { CompanionCommand } from '../../src/shared/contract/companion';

describe('companion uses the desktop live approval authority', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let island: OrchestratorPermissionIsland;
  let service: CompanionApprovalService;
  let handlers: Parameters<typeof installPermissionResponseHandler>[0]['handlers'];
  const sessionId = 'approval-session';
  beforeEach(() => {
    db = new Database(':memory:'); handlers = new Map();
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } }),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true, onEvent: () => {},
    });
    registerForegroundPermissionIsland(sessionId, island);
    const deliver = installPermissionResponseHandler({ handlers, pendingDevPermissions: new Map(), getCurrentSessionId: () => sessionId,
      logger: { info: () => {}, warn: () => {} } });
    gateway = new CompanionGateway(db, { refreshDecisions: () => service.refresh(), decide: command => service.respond(command) });
    service = new CompanionApprovalService(gateway, listForegroundPermissionRequests, deliver);
    gateway.registerDevice({ deviceId: 'phone', credentialHash: 'hash', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
  });
  afterEach(() => { island.drainPendingPermissions(); unregisterForegroundPermissionIsland(sessionId, island); db.close(); });
  function pending() {
    const promise = island.requestPermission({ type: 'file_write', tool: 'write_file', sessionId, forceConfirm: true,
      details: { path: '/tmp/neo-approval-test.txt', newContent: 'bounded test content' } });
    const request = island.listPendingRequests()[0]; service.refresh();
    const card = gateway.getDecision(request.id)!;
    const command: Extract<CompanionCommand, { action: 'approval.respond' }> = { version: 1, deviceId: 'phone', scopeEpoch: 1,
      commandId: 'command-one', sessionId, action: 'approval.respond', expectedRevision: card.revision,
      payload: { requestId: request.id, operationDigest: card.operationDigest!, decision: 'approved' } };
    return { promise, request, command };
  }
  it('mobile approval releases the actual pending tool Promise and closes the desktop request', async () => {
    const { promise, request, command } = pending();
    expect(gateway.syncForDevice('phone', 1, 0).events[0].payload.preview).toContain('bounded test content');
    expect(gateway.submit(command).kind).toBe('accepted');
    await expect(promise).resolves.toEqual({ approved: true, approvalSource: 'user' });
    expect(island.listPendingRequests()).toEqual([]);
    expect(await handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, request.id, 'deny', sessionId)).toMatchObject({ success: false });
    expect(gateway.submit({ ...command, commandId: 'command-two' }).kind).toBe('approval_conflict');
  });
  it('drops publishedEpoch for a request after respond succeeds', async () => {
    const { promise, request, command } = pending();
    const published = (service as unknown as { publishedEpoch: Map<string, number> }).publishedEpoch;
    expect(published.has(request.id)).toBe(true);
    expect(gateway.submit(command).kind).toBe('accepted');
    await expect(promise).resolves.toEqual({ approved: true, approvalSource: 'user' });
    expect(published.has(request.id)).toBe(false);
  });
  it('desktop winning first prevents a stale mobile approval', async () => {
    const { promise, request, command } = pending();
    await handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, request.id, 'deny', sessionId);
    expect(gateway.submit(command).kind).toBe('approval_conflict');
    await expect(promise).resolves.toMatchObject({ approved: false });
  });
  it('lost durable receipt cannot repeat the same logical approval with a new command ID', async () => {
    const { promise, command } = pending();
    db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON companion_commands BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(gateway.submit(command)).toMatchObject({ command: { state: 'reconciling' } });
    await expect(promise).resolves.toMatchObject({ approved: true });
    expect(gateway.submit(command)).toMatchObject({ command: { state: 'reconciling' } });
    expect(gateway.submit({ ...command, commandId: 'another' }).kind).toBe('approval_conflict');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_decision_claims').get()).toEqual({ n: 1 });
  });
  it.each(['revision', 'digest', 'session'] as const)('rejects a changed %s before delivery', async field => {
    const { promise, command } = pending();
    if (field === 'revision') command.expectedRevision++;
    if (field === 'digest') command.payload.operationDigest = 'wrong-digest';
    if (field === 'session') command.sessionId = 'unshared';
    expect(gateway.submit(command).kind).toBe(field === 'session' ? 'rejected' : 'approval_conflict');
    expect(island.listPendingRequests()).toHaveLength(1);
    island.drainPendingPermissions(); await expect(promise).resolves.toMatchObject({ approved: false });
  });
  it('mobile denial reaches the real pending operation', async () => {
    const { promise, command } = pending(); command.payload.decision = 'rejected';
    expect(gateway.submit(command)).toMatchObject({ command: { state: 'resolved', result: { decision: 'rejected' } } });
    await expect(promise).resolves.toMatchObject({ approved: false, denialSource: 'user' });
  });
  it('oversized operation details never create an actionable truncated card', () => {
    void island.requestPermission({ type: 'file_write', tool: 'write_file', sessionId, forceConfirm: true, details: { newContent: 'x'.repeat(17000) } });
    service.refresh(); expect(gateway.pendingDecisions()).toEqual([]);
  });
  it('a parked SQLite failure or lost CAS is not reported as delivered', async () => {
    db.exec(`CREATE TABLE pending_approvals (id TEXT PRIMARY KEY,kind TEXT,agent_id TEXT,agent_name TEXT,coordinator_id TEXT,payload_json TEXT,status TEXT,submitted_at INTEGER,resolved_at INTEGER,feedback TEXT)`);
    const repo = new PendingApprovalRepository(db);
    const parked = new OrchestratorPermissionIsland({ getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false } } }),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true, onEvent: () => {}, injectedPendingApprovalRepo: repo });
    const promise = parked.requestPermission({ type: 'directory_access', tool: 'request_directory', sessionId, details: { path: '/tmp/neo-approval-project' } });
    const id = parked.listPendingRequests()[0].id;
    db.exec("CREATE TRIGGER fail_parked BEFORE UPDATE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'injected'); END");
    // 台账写不进去要报成可重试的 'storage_unavailable'，不能混进 'unknown_request'——
    // 上层看到后者就会把这行 fail-closed 收掉，用户的「允许」从此再也裁决不了。
    expect(parked.handlePermissionResponse(id, 'allow')).toBe('storage_unavailable');
    expect(parked.handlePermissionResponse(id, 'allow', { path: '/tmp/edited' })).toBe('storage_unavailable');
    expect(parked.listPendingRequests()).toHaveLength(1);
    expect(db.prepare('SELECT status FROM pending_approvals WHERE id = ?').get(id)).toEqual({ status: 'pending' });
    db.exec('DROP TRIGGER fail_parked');
    expect(parked.handlePermissionResponse(id, 'deny')).toBe('delivered');
    expect(parked.handlePermissionResponse(id, 'allow')).toBe('unknown_request');
    await expect(promise).resolves.toMatchObject({ approved: false });
    expect(repo.resolve({ id, status: 'approved', feedback: null, resolvedAt: 2000 })).toBe(0);
  });

});

// 上一轮我们把「台账瞬时写失败 → 可重试」这条路打通了一半：用户被引导去再点一次，
// 而重试撞上 approval claim 行没回滚，被 INSERT OR IGNORE 静默吞掉，返回 reconciling，
// companionStore 见 reconciling 直接 return —— saved.pending 永不清除，整台设备锁死。
// 修了一半的重试路径比不修更糟，所以这里钉住的是完整链路，不是单点。
// 桌面 app 关着、手机在线，模型对一个大文件发起 write_file 审批：preview 撑破 16000 字符，
// 卡片被跳过（不 register 也不 publish），而 hasApprovalUi 只看「通道在不在线」仍答 true，
// 于是 fail-closed 超时被取消 —— 手机零卡片、桌面无人接、运行永久挂死。
// 同样输入在 main 上是 5 分钟后拒绝、运行继续，所以这条分支必须做到「不劣于 main」。
describe('an approval no surface can render must keep its fail-closed timeout', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let island: OrchestratorPermissionIsland;
  let service: CompanionApprovalService;
  const sessionId = 'oversized-session';
  // 生产接线：hasInteractiveUi() 为 false（桌面关着），答案完全由 companion 侧给。
  // 见 src/web/app.ts —— 通道可达 **且** 这张卡渲染得出来，两个都成立才算有 UI。
  // 通道可达是会随时间失效的（LanCompanionServer 的 expiresAt 建链后不续期，到点被
  // prune() 拆除），所以这里是个谓词而不是常量。
  let phoneChannelLive: () => boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    phoneChannelLive = () => true;
    db = new Database(':memory:');
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } }),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main',
      hasApprovalUi: request => phoneChannelLive() && service.canDisplay(request),
      onEvent: () => {},
    });
    registerForegroundPermissionIsland(sessionId, island);
    const deliver = installPermissionResponseHandler({ handlers: new Map(), pendingDevPermissions: new Map(),
      getCurrentSessionId: () => sessionId, logger: { info: () => {}, warn: () => {} } });
    gateway = new CompanionGateway(db, { refreshDecisions: () => service.refresh(), decide: command => service.respond(command) });
    service = new CompanionApprovalService(gateway, listForegroundPermissionRequests, deliver);
    gateway.registerDevice({ deviceId: 'phone', credentialHash: 'hash', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
  });
  afterEach(() => {
    island.drainPendingPermissions();
    unregisterForegroundPermissionIsland(sessionId, island);
    db.close();
    vi.useRealTimers();
  });

  const write = (newContent: string) => island.requestPermission({
    type: 'file_write', tool: 'write_file', sessionId, forceConfirm: true,
    details: { path: '/tmp/neo-oversized.txt', newContent },
  });

  it('超长 preview 的审批：卡片确实没发出去，超时就必须照旧生效', async () => {
    const promise = write('x'.repeat(COMPANION_LIMITS.approvalPreviewLength + 1_000));
    service.refresh();

    // 前提复现：这张卡确实一个字都没送出去
    expect(gateway.pendingDecisions()).toEqual([]);
    expect(gateway.syncForDevice('phone', 1, 0).events).toEqual([]);

    // 不劣于 main：fail-closed 超时没有被取消，到点按机器拒绝解除，运行继续。
    // 不直接 await promise —— 修复被摘掉时它永不 resolve，那样只会拿到一个 30s 超时，
    // 看不出是「挂死」还是「测试写慢了」。
    let outcome: unknown = 'still-pending';
    void promise.then(value => { outcome = value; });
    await vi.advanceTimersByTimeAsync(EDITABLE_PERMISSION_TIMEOUT_MS + 1_000);
    expect(outcome, 'fail-closed 超时被取消了：这次运行会永久挂在一个谁也没看见的 tool call 上')
      .toEqual({ approved: false, denialSource: 'timeout' });
  });

  it('卡片送得出去时才免超时——正常大小的审批仍然一直等真人裁决', async () => {
    const promise = write('bounded content');
    service.refresh();

    // 卡片真的到了手机上
    expect(gateway.syncForDevice('phone', 1, 0).events[0].payload.preview).toContain('bounded content');

    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(EDITABLE_PERMISSION_TIMEOUT_MS + 1_000);
    expect(settled, '卡片送达时不该再有 fail-closed 超时——那会把真人还没看的审批自动拒掉').toBe(false);
  });

  it('在场 TTL 过期后必须重判——不能把创建时的 true 用到超时全程', async () => {
    let present = true;
    phoneChannelLive = () => present;
    const promise = write('bounded content');
    service.refresh();
    expect(gateway.syncForDevice('phone', 1, 0).events[0].payload.preview).toContain('bounded content');

    let outcome: unknown = 'still-pending';
    void promise.then(value => { outcome = value; });

    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.uiPresenceTtlMs);
    expect(outcome, '在场尚未撤销时就超时拒绝，等于把用户还没看到的审批替他拒了').toBe('still-pending');

    present = false;
    await vi.advanceTimersByTimeAsync(60_000 + 15_000);
    expect(outcome, '手机离网后还停在创建时的 true：这次运行会永久挂在一个两端都看不见的 tool call 上')
      .toEqual({ approved: false, denialSource: 'timeout' });
  });

  it('通道到点被拆之后必须重判——不能永远停在 t=0 那个 true', async () => {
    // 手机通道建链即固定到期，到点被 LanCompanionServer.prune() 无条件拆掉，
    // 而没有任何事件回来通知审批岛。t=0 判到的「有 UI」在那之后不再成立。
    const openedAt = Date.now();
    phoneChannelLive = () => Date.now() - openedAt < COMPANION_LIMITS.channelTtlMs;

    const promise = write('bounded content');
    service.refresh();
    // 前提：这张卡当时确实送到了手机上，免超时是当时的正确决定
    expect(gateway.syncForDevice('phone', 1, 0).events[0].payload.preview).toContain('bounded content');

    let outcome: unknown = 'still-pending';
    void promise.then(value => { outcome = value; });

    // 通道还在的这段：不该有 fail-closed 超时把真人没看的审批自动拒掉
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.channelTtlMs - 1_000);
    expect(outcome, '通道还在时就超时拒绝，等于把用户还没看到的审批替他拒了').toBe('still-pending');

    // 通道到点被拆，此后两端都没有人能看见这张卡
    expect(phoneChannelLive()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(phoneChannelLive()).toBe(false);

    // 必须有人重判：要么 fail-closed 拒绝、run 继续，绝不是永久挂起
    await vi.advanceTimersByTimeAsync(EDITABLE_PERMISSION_TIMEOUT_MS + 60_000);
    expect(outcome, '通道拆了之后没有人重判：这次运行会永久挂在一个两端都看不见的 tool call 上，既不完成也不报错')
      .toEqual({ approved: false, denialSource: 'timeout' });
  });
});

describe('a half-open retry path must not lock the device', () => {
  let db: Database.Database;
  let repo: PendingApprovalRepository;
  let island: OrchestratorPermissionIsland;
  let gateway: CompanionGateway;
  let service: CompanionApprovalService;
  const sessionId = 'parked-retry-session';

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE pending_approvals (id TEXT PRIMARY KEY,kind TEXT,agent_id TEXT,agent_name TEXT,coordinator_id TEXT,payload_json TEXT,status TEXT,submitted_at INTEGER,resolved_at INTEGER,feedback TEXT)');
    repo = new PendingApprovalRepository(db);
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } }),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true,
      onEvent: () => {}, injectedPendingApprovalRepo: repo,
    });
    registerForegroundPermissionIsland(sessionId, island);
    const deliver = installPermissionResponseHandler({ handlers: new Map(), pendingDevPermissions: new Map(),
      getCurrentSessionId: () => sessionId, logger: { info: () => {}, warn: () => {} } });
    gateway = new CompanionGateway(db, {
      refreshDecisions: () => service.refresh(),
      decide: command => service.respond(command),
      dispatch: () => ({ state: 'accepted', result: { runId: 'run-after-retry' } }),
    });
    service = new CompanionApprovalService(gateway, listForegroundPermissionRequests, deliver);
    gateway.registerDevice({ deviceId: 'phone', credentialHash: 'hash', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
  });
  afterEach(() => { island.drainPendingPermissions(); unregisterForegroundPermissionIsland(sessionId, island); db.close(); });

  const claims = () => (db.prepare('SELECT COUNT(*) AS n FROM companion_decision_claims').get() as { n: number }).n;

  it('a fresh commandId after a transient ledger failure really decides, and the device stays usable', async () => {
    const promise = island.requestPermission({ type: 'directory_access', tool: 'request_directory', sessionId,
      details: { path: '/tmp/neo-claim-retry' } });
    const request = island.listPendingRequests()[0];
    service.refresh();
    const card = gateway.getDecision(request.id)!;
    const respond = (commandId: string) => ({ version: 1 as const, deviceId: 'phone', scopeEpoch: 1, commandId,
      sessionId, action: 'approval.respond' as const, expectedRevision: card.revision,
      payload: { requestId: request.id, operationDigest: card.operationDigest!, decision: 'approved' as const } });

    // 台账这一次写不进去（等价于瞬时 SQLITE_BUSY）：裁决必然没做成
    db.exec("CREATE TRIGGER fail_parked BEFORE UPDATE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY injected'); END");
    expect(gateway.submit(respond('first'))).toMatchObject({ command: { state: 'rejected' } });
    expect(gateway.getDecision(request.id)).toMatchObject({ status: 'pending' });
    expect(db.prepare('SELECT status FROM pending_approvals WHERE id = ?').get(request.id)).toEqual({ status: 'pending' });
    // 没做成就不许留下 claim——留着的话下面这次重试会被静默吞掉
    expect(claims()).toBe(0);

    db.exec('DROP TRIGGER fail_parked');
    // 这一步就是我们上一轮把用户引向的动作：换个 commandId 再点一次
    const retried = gateway.submit(respond('second'));
    expect(retried).toMatchObject({ kind: 'accepted', command: { state: 'resolved', result: { decision: 'approved' } } });
    // 不是 reconciling：companionStore 见到 reconciling 会直接 return，pending 永不清除
    expect(gateway.commandStatus('phone', 'second')?.state).toBe('resolved');
    // 桌面那条真实的挂起 Promise 确实被这次重试放行了
    await expect(promise).resolves.toMatchObject({ approved: true });
    expect(db.prepare('SELECT status FROM pending_approvals WHERE id = ?').get(request.id)).toEqual({ status: 'approved' });
    // 成功之后 claim 必须留着：换 commandId 不得重放一个已经生效的逻辑裁决
    expect(claims()).toBe(1);
    expect(gateway.submit(respond('third')).kind).toBe('approval_conflict');

    // 设备没被卡死：后续普通命令照常受理
    expect(gateway.submit({ version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'after-retry',
      sessionId, action: 'message.send', payload: { text: 'still usable' } }))
      .toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
  });
});
