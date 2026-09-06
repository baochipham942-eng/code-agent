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
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { HostReasonCode } from '../../../src/shared/contract/permission';

const settings = (overrides: Partial<AppSettings['permissions']> = {}): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
    ...overrides,
  },
} as AppSettings);

function makeRepo(): PendingApprovalRepository & { insert: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { insert: ReturnType<typeof vi.fn> };
}

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

describe('停车判定先于自动批准', () => {
  beforeEach(() => {
    resetPermissionModeManager();
  });

  afterEach(() => {
    resetPermissionModeManager();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function makeIsland(
    permissionSettings: Partial<AppSettings['permissions']>,
    repo: PendingApprovalRepository | undefined,
    topology: 'main' | 'async_agent' = 'main',
    devSlotEnabled = permissionSettings.devModeAutoApprove === true,
  ) {
    return new OrchestratorPermissionIsland({
      getSettings: () => settings(permissionSettings),
      isDevModeAutoApproveEnabled: () => devSlotEnabled,
      getExecutionTopology: () => topology,
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });
  }

  it('live-voice + devModeAutoApprove 写请求仍停车，不秒批', async () => {
    const repo = makeRepo();
    const sessionId = 'live-voice-devmode';
    getPermissionModeManager().markLiveVoiceSession(sessionId, 'run:voice');
    const island = makeIsland({ devModeAutoApprove: true }, repo);

    const result = island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/Users/linchen/probe.txt' }, sessionId });

    expect(await isStillPending(result)).toBe(true);
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('unattended 残余 ask 不停车，60 秒后留下可消费的结构化终态', async () => {
    vi.useFakeTimers();
    const repo = makeRepo();
    const sessionId = 'unattended-autoapprove-write';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings({ autoApprove: { read: false, write: true, execute: false, network: false } }),
      isDevModeAutoApproveEnabled: () => true,
      getExecutionTopology: () => 'async_agent',
      // 即使应用进程有 renderer，cron turn 也不能冒充交互会话无限等。
      hasApprovalUi: () => true,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });

    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/Users/linchen/probe.txt' },
      sessionId,
      forceConfirm: true,
    });

    expect(await isStillPending(result)).toBe(true);
    expect(repo.insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect(island.consumeUnattendedTerminalFailure()).toMatchObject({
      code: HostReasonCode.PermissionDeniedTimeout,
      sessionId,
      tool: 'write_file',
    });
    expect(island.consumeUnattendedTerminalFailure()).toBeNull();
  });

  it('交互 session 内的后台 unattended run 也走有限超时，不改变该 session 的交互档', async () => {
    vi.useFakeTimers();
    const sessionId = 'attended-parent-background-run';
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings({}),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: makeRepo(),
    });

    const result = island.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'unknown-command' },
      sessionId,
      unattended: true,
      forceConfirm: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect(getPermissionModeManager().getModeForSession(sessionId)).toBe('default');
    expect(island.consumeUnattendedTerminalFailure()).toBeNull();
  });

  it('权限档自动批准自报来源', async () => {
    const island = makeIsland({ autoApprove: { read: true, write: false, execute: false, network: false } }, makeRepo());
    await expect(island.requestPermission({ type: 'file_read', tool: 'read_file', details: {}, sessionId: 'attended-level' }))
      .resolves.toEqual({ approved: true, approvalSource: 'auto-approve-level' });
  });

  it('普通有人值守 + devModeAutoApprove 仍直接放行', async () => {
    const island = makeIsland({ devModeAutoApprove: true }, makeRepo());

    await expect(island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/x' }, sessionId: 'attended' })).resolves.toEqual({ approved: true, approvalSource: 'dev-auto-approve' });
  });

  it('2026-08-28 爸拍板 v2 §1.4/§12 删除 AUTO_TEST 后门：directory_access 仍走停车台账', async () => {
    vi.stubEnv('AUTO_TEST', 'true');
    const repo = makeRepo();
    const island = makeIsland({}, repo);

    const result = island.requestPermission({
      type: 'directory_access',
      tool: 'request_directory',
      details: { path: '/tmp/auto-test-must-park' },
      sessionId: 'auto-test-must-park',
    });

    expect(await isStillPending(result)).toBe(true);
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('2026-08-28 爸拍板 v2 §1.4/§12 删除 AUTO_TEST 后门：停车台账不可用仍 fail-closed', async () => {
    vi.stubEnv('AUTO_TEST', 'true');
    const island = makeIsland({}, undefined);

    await expect(island.requestPermission({
      type: 'directory_access',
      tool: 'request_directory',
      details: { path: '/tmp/auto-test-no-repo' },
      sessionId: 'auto-test-no-repo',
    })).resolves.toEqual({ approved: false, denialSource: 'fail-closed' });
  });

  it('AUTO_TEST=false 不放行目录扩权请求', async () => {
    vi.stubEnv('AUTO_TEST', 'false');
    const island = makeIsland({}, undefined);

    await expect(island.requestPermission({
      type: 'directory_access',
      tool: 'request_directory',
      details: { path: '/tmp/not-auto-test' },
      sessionId: 'auto-test-false',
    })).resolves.toEqual({ approved: false, denialSource: 'fail-closed' });
  });

  it('非 dev 槽即使原始开关为 true 也必须发起审批', async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings({ devModeAutoApprove: true }),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: makeRepo(),
    });

    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/production-must-ask' },
      sessionId: 'production',
    });

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'permission_request' }));
    expect(await isStillPending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({ resolved: true, decision: 'timeout' }),
    }));
  });

  it('AUTO_TEST=true 的普通 file_write 仍走正常审批路径', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AUTO_TEST', 'true');
    const onEvent = vi.fn();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings({}),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: makeRepo(),
    });

    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/auto-test-normal-approval.txt' },
      sessionId: 'auto-test-normal-approval',
    });

    expect(await isStillPending(result)).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({ type: 'file_write' }),
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
  });

  it('async_agent 的 catalog 只读 MCP 工具仍免审放行，不停车', async () => {
    const repo = makeRepo();
    const sessionId = 'async-readonly-mcp';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = makeIsland({}, repo, 'async_agent');

    await expect(island.requestPermission({
      type: 'file_read',
      tool: 'mcp__lark__calendar_v4_calendarEvent_list',
      details: {},
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'unattended-readonly' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('live-voice 停车台账不可用时不经 devModeAutoApprove 放行', async () => {
    vi.useFakeTimers();
    const sessionId = 'live-voice-no-repo';
    getPermissionModeManager().markLiveVoiceSession(sessionId, 'run:voice');
    const island = makeIsland({ devModeAutoApprove: true }, undefined);

    const result = island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/Users/linchen/probe.txt' }, sessionId });

    expect(await isStillPending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    // N-PERMTRACE：60s 超时是机器拒的，必须自报 timeout，不许冒名 user。
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'timeout' });
  });
});
