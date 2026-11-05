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
  takeUnattendedApprovalDenials,
  takeUnattendedApprovalTimeout,
  UNATTENDED_APPROVAL_TIMEOUT,
} from '../../../src/host/agent/unattendedApprovalTerminal';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeRepo() {
  return { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository & {
    resolve: ReturnType<typeof vi.fn>;
  };
}

function makeIsland(repo: PendingApprovalRepository, onEvent = vi.fn()) {
  return new OrchestratorPermissionIsland({
    getSettings: () => settings(),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => false,
    onEvent,
    injectedPendingApprovalRepo: repo,
  });
}

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

const bash = (sessionId: string) => ({
  type: 'command' as const,
  tool: 'Bash',
  details: { command: 'node refresh-wechat.js' },
  sessionId,
});

const DEGRADE_MS = INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE;

describe('cron/heartbeat 停车审批 30 分钟降级拒绝', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
  });

  it('cron 29:59 仍挂着，30:00 拒绝并带原因码与「未读取」指引；channel 30:00 仍挂着', async () => {
    const mode = getPermissionModeManager();
    mode.markUnattendedSession('cron-s');
    mode.markUnattendedApprovalDegrade('cron-s');
    mode.markUnattendedSession('chan-s');
    const cronRepo = makeRepo();
    const chanRepo = makeRepo();
    const cron = makeIsland(cronRepo).requestPermission(bash('cron-s'));
    const chan = makeIsland(chanRepo).requestPermission(bash('chan-s'));

    await vi.advanceTimersByTimeAsync(DEGRADE_MS - 1_000);
    expect(await isStillPending(cron)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const verdict = await cron;
    expect(verdict).toMatchObject({ approved: false, denialSource: 'timeout' });
    expect(verdict.message).toContain(UNATTENDED_APPROVAL_TIMEOUT);
    expect(verdict.message).toContain('未读取：<来源>（需要你批准）');
    expect(verdict.message).toContain('Bash');
    expect(cronRepo.resolve).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));

    expect(await isStillPending(chan)).toBe(true);
    expect(chanRepo.resolve).not.toHaveBeenCalled();
  });

  it('降级拒绝不写 run 终态码（run 不会被当失败、job 不会被自动停用），只留降级留痕', async () => {
    const mode = getPermissionModeManager();
    mode.markUnattendedSession('cron-t');
    mode.markUnattendedApprovalDegrade('cron-t');
    const result = makeIsland(makeRepo()).requestPermission(bash('cron-t'));
    await vi.advanceTimersByTimeAsync(DEGRADE_MS);
    await result;

    expect(takeUnattendedApprovalTimeout('cron-t')).toBeUndefined();
    const denials = takeUnattendedApprovalDenials('cron-t');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool: 'Bash', code: UNATTENDED_APPROVAL_TIMEOUT });
    expect(takeUnattendedApprovalDenials('cron-t')).toEqual([]);
  });

  it('对照：29 分钟批准照常放行且无降级留痕；10 分钟用户拒绝照旧', async () => {
    const mode = getPermissionModeManager();
    for (const id of ['cron-a', 'cron-d']) {
      mode.markUnattendedSession(id);
      mode.markUnattendedApprovalDegrade(id);
    }
    const approveEvents = vi.fn();
    const approveIsland = makeIsland(makeRepo(), approveEvents);
    const approved = approveIsland.requestPermission(bash('cron-a'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const aid = (approveEvents.mock.calls[0]?.[0] as { data: { id: string } }).data.id;
    expect(approveIsland.resolveParkedApproval(aid, 'allow')).toBe(true);
    await expect(approved).resolves.toEqual({ approved: true, approvalSource: 'user' });
    await vi.advanceTimersByTimeAsync(DEGRADE_MS);
    expect(takeUnattendedApprovalDenials('cron-a')).toEqual([]);

    const denyEvents = vi.fn();
    const denyIsland = makeIsland(makeRepo(), denyEvents);
    const denied = denyIsland.requestPermission(bash('cron-d'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const did = (denyEvents.mock.calls[0]?.[0] as { data: { id: string } }).data.id;
    expect(denyIsland.resolveParkedApproval(did, 'deny', '不要跑')).toBe(true);
    await expect(denied).resolves.toEqual({ approved: false, denialSource: 'user', message: '不要跑' });
    await vi.advanceTimersByTimeAsync(DEGRADE_MS);
    expect(takeUnattendedApprovalDenials('cron-d')).toEqual([]);
  });
});
