import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const notificationState = vi.hoisted(() => ({
  notifyNeedsInput: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: notificationState,
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import {
  takeUnattendedApprovalTimeout,
  UNATTENDED_APPROVAL_TIMEOUT,
} from '../../../src/host/agent/unattendedApprovalTerminal';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import { requestPermissionWithTelemetry } from '../../../src/host/tools/toolExecutionTelemetry';
import { createHumanWaitBoundTimeout, isHumanWaitActive } from '../../../src/host/services/infra/timeoutController';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: true, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeRepo(): PendingApprovalRepository & { resolve: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { resolve: ReturnType<typeof vi.fn> };
}

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

function makeIsland(hasApprovalUi: boolean, repo: PendingApprovalRepository) {
  return new OrchestratorPermissionIsland({
    getSettings: () => settings(),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => hasApprovalUi,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: repo,
  });
}

describe('无人值守审批超时进终态', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    notificationState.notifyNeedsInput.mockClear();
  });

  it('cron 会话 60s 拒绝并记下原因码，不按写权限自动放行', async () => {
    const repo = makeRepo();
    const sessionId = 'cron-terminal';
    getPermissionModeManager().markUnattendedSession(sessionId);
    getPermissionModeManager().markUnattendedApprovalTerminal(sessionId);
    const island = makeIsland(false, repo);
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/probe.txt' },
      sessionId,
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(await isStillPending(result)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({
      approved: false,
      denialSource: 'timeout',
      message: UNATTENDED_APPROVAL_TIMEOUT,
    });
    expect(repo.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'rejected',
      feedback: UNATTENDED_APPROVAL_TIMEOUT,
    }));
    expect(takeUnattendedApprovalTimeout(sessionId)).toBe(UNATTENDED_APPROVAL_TIMEOUT);
    expect(takeUnattendedApprovalTimeout(sessionId)).toBeUndefined();
  });

  it('cron/heartbeat 会话停车等人，60s 后仍可批准并把同一审批继续下去', async () => {
    const repo = makeRepo();
    const onEvent = vi.fn();
    const sessionId = 'cron-parked';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: repo,
    });
    const timeout = createHumanWaitBoundTimeout(1_000, 'tool timeout', sessionId);
    const result = requestPermissionWithTelemetry({
      toolCallId: 'tool-parked',
      request: {
        type: 'file_write',
        tool: 'write_file',
        details: { path: '/tmp/parked.txt' },
        sessionId,
      },
      requestPermission: (request) => island.requestPermission(request),
    });

    expect(isHumanWaitActive(sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await isStillPending(result)).toBe(true);
    expect(timeout.controller.isTimedOut()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await isStillPending(result)).toBe(true);
    expect(notificationState.notifyNeedsInput).toHaveBeenCalledTimes(1);

    const requestId = (onEvent.mock.calls[0]?.[0] as { data?: { id?: string } })?.data?.id;
    expect(requestId).toBeTruthy();
    expect(island.handlePermissionResponse(requestId!, 'allow')).toBe('delivered');
    await expect(result).resolves.toEqual({ approved: true, approvalSource: 'user' });
    expect(isHumanWaitActive(sessionId)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timeout.promise).rejects.toThrow('tool timeout');
  });

  it('停车审批拒绝时把用户理由传给模型', async () => {
    const repo = makeRepo();
    const onEvent = vi.fn();
    const sessionId = 'cron-rejected';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: repo,
    });
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/rejected.txt' },
      sessionId,
    });
    await Promise.resolve();

    const requestId = (onEvent.mock.calls[0]?.[0] as { data?: { id?: string } })?.data?.id;
    expect(requestId).toBeTruthy();
    expect(island.resolveParkedApproval(requestId!, 'deny', '用户说明：这次不要写入')).toBe(true);
    await expect(result).resolves.toEqual({
      approved: false,
      denialSource: 'user',
      message: '用户说明：这次不要写入',
    });
    expect(repo.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'rejected',
      feedback: '用户说明：这次不要写入',
    }));
  });

  it('停车超过 24h backstop 时以明确原因终止', async () => {
    const repo = makeRepo();
    const onEvent = vi.fn();
    const sessionId = 'cron-expired';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: repo,
    });
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/expired.txt' },
      sessionId,
    });

    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.PARKED_APPROVAL);
    await expect(result).resolves.toEqual({
      approved: false,
      denialSource: 'timeout',
      message: 'parked approval expired',
    });
    expect(repo.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'rejected',
      feedback: 'parked approval expired',
    }));
  });

  it('有审批界面的交互会话过了 60s 仍不自动拒绝', async () => {
    const repo = makeRepo();
    const island = makeIsland(true, repo);
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/probe.txt' },
      sessionId: 'chat-session',
      forceConfirm: true,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await isStillPending(result)).toBe(true);
    expect(repo.resolve).not.toHaveBeenCalled();
    expect(takeUnattendedApprovalTimeout('chat-session')).toBeUndefined();
  });

  it('channel 会话只标 unattended，60s 仍停车', async () => {
    const repo = makeRepo();
    const sessionId = 'channel-session';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = makeIsland(false, repo);
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/probe.txt' },
      sessionId,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await isStillPending(result)).toBe(true);
    expect(repo.resolve).not.toHaveBeenCalled();
    expect(takeUnattendedApprovalTimeout(sessionId)).toBeUndefined();
  });

  it('语音派过了 60s 仍停车，不记无人值守原因码', async () => {
    const repo = makeRepo();
    const sessionId = 'voice-session';
    getPermissionModeManager().markLiveVoiceSession(sessionId, 'run:voice');
    const island = makeIsland(false, repo);
    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/probe.txt' },
      sessionId,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await isStillPending(result)).toBe(true);
    expect(repo.resolve).not.toHaveBeenCalled();
    expect(takeUnattendedApprovalTimeout(sessionId)).toBeUndefined();
  });
});
