import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import {
  takeUnattendedApprovalTimeout,
  UNATTENDED_APPROVAL_TIMEOUT,
} from '../../../src/host/agent/unattendedApprovalTerminal';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

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
  });

  it('cron 会话 60s 拒绝并记下原因码，不按写权限自动放行', async () => {
    const repo = makeRepo();
    const sessionId = 'cron-terminal';
    getPermissionModeManager().markUnattendedSession(sessionId);
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
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect(repo.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'rejected',
      feedback: UNATTENDED_APPROVAL_TIMEOUT,
    }));
    expect(takeUnattendedApprovalTimeout(sessionId)).toBe(UNATTENDED_APPROVAL_TIMEOUT);
    expect(takeUnattendedApprovalTimeout(sessionId)).toBeUndefined();
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
