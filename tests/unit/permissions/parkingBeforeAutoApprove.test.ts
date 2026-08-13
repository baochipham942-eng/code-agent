import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
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

function isStillPending(promise: Promise<boolean>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

describe('停车判定先于自动批准', () => {
  beforeEach(() => {
    resetPermissionModeManager();
  });

  afterEach(() => {
    resetPermissionModeManager();
    vi.useRealTimers();
  });

  function makeIsland(
    permissionSettings: Partial<AppSettings['permissions']>,
    repo: PendingApprovalRepository | undefined,
    topology: 'main' | 'async_agent' = 'main',
  ) {
    return new OrchestratorPermissionIsland({
      getSettings: () => settings(permissionSettings),
      getExecutionTopology: () => topology,
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

  it('unattended + autoApprove.write 写请求仍停车，不秒批', async () => {
    const repo = makeRepo();
    const sessionId = 'unattended-autoapprove-write';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = makeIsland({ autoApprove: { read: false, write: true, execute: false, network: false } }, repo);

    const result = island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/Users/linchen/probe.txt' }, sessionId });

    expect(await isStillPending(result)).toBe(true);
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('普通有人值守 + devModeAutoApprove 仍直接放行', async () => {
    const island = makeIsland({ devModeAutoApprove: true }, makeRepo());

    await expect(island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/x' }, sessionId: 'attended' })).resolves.toBe(true);
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
    })).resolves.toBe(true);
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
    await expect(result).resolves.toBe(false);
  });
});
