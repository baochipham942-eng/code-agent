import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: true, write: true, execute: true, network: true },
    blockedCommands: [],
    devModeAutoApprove: true,
  },
} as unknown as AppSettings);

function makeRepo(): PendingApprovalRepository & { resolve: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { resolve: ReturnType<typeof vi.fn> };
}

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([promise, Promise.resolve(marker)]).then((result) => result === marker);
}

describe('转向作废交互审批卡', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPermissionModeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
  });

  it('交互卡以 superseded 机器取消，停车审批仍挂着且稍后允许能送达', async () => {
    const repo = makeRepo();
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => true,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event),
      injectedPendingApprovalRepo: repo,
    });
    getPermissionModeManager().markUnattendedSession('parked-session');

    const parked = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/keep.txt' },
      sessionId: 'parked-session',
    });
    const interactive = island.requestPermission({
      type: 'file_delete',
      tool: 'Bash',
      details: { command: 'rm b.txt' },
      sessionId: 'attended',
      forceConfirm: true,
    });
    const pending = island.listPendingRequests();
    const interactiveRequest = pending.find((request) => request.sessionId === 'attended');
    const parkedRequest = pending.find((request) => request.sessionId === 'parked-session');
    expect(interactiveRequest).toBeTruthy();
    expect(parkedRequest).toBeTruthy();

    island.supersedeInteractivePendingApprovals();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({
        id: interactiveRequest!.id,
        resolved: true,
        decision: 'superseded',
      }),
    }));
    expect(events.filter((event) => (
      event.type === 'permission_request'
      && event.data.decision === 'superseded'
    ))).toHaveLength(1);
    await expect(interactive).resolves.toEqual({ approved: false, denialSource: 'cancelled' });
    expect(island.handlePermissionResponse(interactiveRequest!.id, 'allow')).toBe('unknown_request');
    expect(repo.resolve).not.toHaveBeenCalled();
    expect(await isStillPending(parked)).toBe(true);
    expect(island.listPendingRequests().map((request) => request.id)).toEqual([parkedRequest!.id]);

    expect(island.handlePermissionResponse(parkedRequest!.id, 'allow')).toBe('delivered');
    await expect(parked).resolves.toEqual({ approved: true, approvalSource: 'user' });
  });
});
