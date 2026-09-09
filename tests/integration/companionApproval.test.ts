import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../src/host/task/TaskManager', () => ({ getTaskManager: () => ({ handlePermissionResponse: () => 'unknown_request' }) }));
vi.mock('../../src/host/agent/parkedApprovalHydration', () => ({ closeDeadParkedApproval: () => false }));
import Database from 'better-sqlite3';
import { PendingApprovalRepository } from '../../src/host/services/core/repositories/PendingApprovalRepository';
import { CompanionGateway } from '../../src/host/companion/CompanionGateway';
import { CompanionApprovalService } from '../../src/host/companion/CompanionApprovalService';
import { OrchestratorPermissionIsland } from '../../src/host/agent/orchestratorPermissions';
import { registerForegroundPermissionIsland, unregisterForegroundPermissionIsland, listForegroundPermissionRequests } from '../../src/web/foregroundPermissionRegistry';
import { installPermissionResponseHandler } from '../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import type { AppSettings } from '../../src/shared/contract';
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
      getSettings: () => ({ permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } } as AppSettings),
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
    const parked = new OrchestratorPermissionIsland({ getSettings: () => ({ permissions: { autoApprove: {} } } as AppSettings),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true, onEvent: () => {}, injectedPendingApprovalRepo: repo });
    const promise = parked.requestPermission({ type: 'directory_access', tool: 'request_directory', sessionId, details: { path: '/tmp/neo-approval-project' } });
    const id = parked.listPendingRequests()[0].id;
    db.exec("CREATE TRIGGER fail_parked BEFORE UPDATE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(parked.handlePermissionResponse(id, 'allow')).toBe('unknown_request');
    expect(parked.handlePermissionResponse(id, 'allow', { path: '/tmp/edited' })).toBe('unknown_request');
    expect(parked.listPendingRequests()).toHaveLength(1);
    db.exec('DROP TRIGGER fail_parked');
    expect(parked.handlePermissionResponse(id, 'deny')).toBe('delivered');
    expect(parked.handlePermissionResponse(id, 'allow')).toBe('unknown_request');
    await expect(promise).resolves.toMatchObject({ approved: false });
    expect(repo.resolve({ id, status: 'approved', feedback: null, resolvedAt: 2000 })).toBe(0);
  });

});
