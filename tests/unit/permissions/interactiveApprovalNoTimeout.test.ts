import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import { EDITABLE_PERMISSION_TIMEOUT_MS } from '../../../src/shared/contract/permissionEdit';

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => logSpies),
  logger: logSpies,
  default: logSpies,
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

type IslandInternals = {
  pendingPermissions: Map<string, unknown>;
};

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([promise, Promise.resolve(marker)]).then((result) => result === marker);
}

function beginApproval(hasApprovalUi: boolean, tool = 'Write') {
  const events: AgentEvent[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => hasApprovalUi,
    onEvent: (event) => events.push(event),
  });
  const promise = island.requestPermission({
    type: 'file_write',
    tool,
    details: { path: '/tmp/approval-probe.txt' },
    sessionId: 'approval-session',
    forceConfirm: true,
  });
  const [request] = island.listPendingRequests();
  if (!request) throw new Error('permission request was not registered');
  return { island, promise, request, events };
}

describe('有审批 UI 的交互请求不因超时自动拒绝', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logSpies.warn.mockClear();
    resetPermissionModeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
  });

  it('交互环境等待 10 分钟后仍 pending，迟到的允许仍能生效', async () => {
    const { island, promise, request, events } = beginApproval(true, 'tmeetMeetingCreate');

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(await isStillPending(promise)).toBe(true);
    expect((island as unknown as IslandInternals).pendingPermissions.has(request.id)).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({ resolved: true, decision: 'timeout' }),
    }));

    expect(island.handlePermissionResponse(request.id, 'allow')).toBe('delivered');
    await expect(promise).resolves.toEqual({ approved: true, approvalSource: 'user' });
  });

  it('30 分钟长闸只告警，仍不删除请求或拒绝', async () => {
    const { island, promise, request } = beginApproval(true);

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('Permission still pending after 30m'),
      expect.objectContaining({ requestId: request.id }),
    );
    expect(await isStillPending(promise)).toBe(true);
    expect((island as unknown as IslandInternals).pendingPermissions.has(request.id)).toBe(true);

    island.drainPendingPermissions();
    await expect(promise).resolves.toEqual({ approved: false, denialSource: 'cancelled' });
  });

  it('无审批 UI 时普通工具 60 秒、可编辑工具 5 分钟照旧 timeout deny', async () => {
    const write = beginApproval(false, 'Write');
    const editable = beginApproval(false, 'tmeetMeetingCreate');

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(write.promise).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect(write.events).toContainEqual(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({ resolved: true, decision: 'timeout' }),
    }));
    expect(await isStillPending(editable.promise)).toBe(true);

    await vi.advanceTimersByTimeAsync(EDITABLE_PERMISSION_TIMEOUT_MS - 60_000);

    await expect(editable.promise).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect((editable.island as unknown as IslandInternals).pendingPermissions.has(editable.request.id)).toBe(false);
  });

  it('运行取消会以 cancelled 解除交互 pending 请求', async () => {
    const { island, promise, request } = beginApproval(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    island.drainPendingPermissions();

    await expect(promise).resolves.toEqual({ approved: false, denialSource: 'cancelled' });
    expect((island as unknown as IslandInternals).pendingPermissions.has(request.id)).toBe(false);
  });
});
