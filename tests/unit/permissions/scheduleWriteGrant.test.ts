// ============================================================================
// 写授权接入 orchestratorPermissions（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ①）：
// 无人值守 cron 会话的界内 file_write/file_edit 在停车分支**之前**被放行；
// 出界 / `..` / 软链逃逸 / forceConfirm / Bash / 非 cron 来源照旧停车（repo.insert 落行，
// Promise 挂起等人）。真实 cronWriteGrant（真文件系统）+ mock sessionManager。
// ============================================================================
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const notificationState = vi.hoisted(() => ({ notifyNeedsInput: vi.fn() }));
const sessionState = vi.hoisted(() => ({
  sessions: {} as Record<string, { id: string; origin?: { kind: string; metadata?: Record<string, unknown> } } | undefined>,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: notificationState,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async (id: string) => sessionState.sessions[id] ?? null,
  }),
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager, getPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    // write:false —— 交互路径的 autoApprove[level] 自动放行与本单无关，不许它抢答。
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

/** 排空微任务链（approveByScheduleWriteGrant 里有动态 import + await，一跳不够）。 */
const flushMicrotasks = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function makeRepo(): PendingApprovalRepository & { insert: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { insert: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };
}

function makeIsland(repo: PendingApprovalRepository) {
  return new OrchestratorPermissionIsland({
    getSettings: () => settings(),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: repo,
  });
}

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

let grantRoot: string;

beforeEach(() => {
  grantRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-island-grant-'));
  sessionState.sessions = {};
});

afterEach(() => {
  resetPermissionModeManager();
  rmSync(grantRoot, { recursive: true, force: true });
});

describe('写授权放行（schedule write grant）', () => {
  it('cron 无人值守会话写授权文件夹内的文件被放行，不落停车台账', async () => {
    const sessionId = 'cron-granted';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeRepo();
    const island = makeIsland(repo);
    await expect(island.requestPermission({
      type: 'file_write',
      tool: 'Write',
      details: { path: path.join(grantRoot, 'today.md') },
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    await expect(island.requestPermission({
      type: 'file_edit',
      tool: 'Edit',
      details: { path: path.join(grantRoot, 'today.md') },
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('出界 / `..` 逃逸 / 软链逃逸目标照旧停车（pending_approvals 落行、Promise 挂起）', async () => {
    const sessionId = 'cron-granted-2';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-island-out-'));
    try {
      symlinkSync(outsideRoot, path.join(grantRoot, 'link-out'));
      const repo = makeRepo();
      const island = makeIsland(repo);
      for (const target of [
        path.join(path.dirname(grantRoot), 'outside.txt'),
        path.join(grantRoot, '..', 'escape.txt'),
        path.join(grantRoot, 'link-out', 'stolen.txt'),
      ]) {
        const result = island.requestPermission({
          type: 'file_write', tool: 'Write', details: { path: target }, sessionId,
        });
        await flushMicrotasks();
        expect(await isStillPending(result)).toBe(true);
        island.drainPendingPermissions();
      }
      expect(repo.insert).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('forceConfirm（含保护路径 ask）与 Bash 照旧停车', async () => {
    const sessionId = 'cron-granted-3';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeRepo();
    const island = makeIsland(repo);
    const forced = island.requestPermission({
      type: 'file_write', tool: 'Write', forceConfirm: true,
      details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
    });
    const bash = island.requestPermission({
      type: 'command', tool: 'Bash',
      details: { command: `echo hi > ${grantRoot}/a.txt` }, sessionId,
    });
    await flushMicrotasks();
    expect(await isStillPending(forced)).toBe(true);
    expect(await isStillPending(bash)).toBe(true);
    expect(repo.insert).toHaveBeenCalledTimes(2);
    island.drainPendingPermissions();
  });

  it('非 cron 来源的会话（无来源 / channel 来源 / 未授权 cron）照旧停车', async () => {
    const plainSession = 'plain-session';
    const channelSession = 'channel-session';
    const ungrantedCron = 'cron-ungranted';
    getPermissionModeManager().markUnattendedSession(plainSession);
    getPermissionModeManager().markUnattendedSession(channelSession);
    getPermissionModeManager().markUnattendedSession(ungrantedCron);
    sessionState.sessions[channelSession] = {
      id: channelSession,
      origin: { kind: 'channel', metadata: { writeGrantRoot: grantRoot } },
    };
    sessionState.sessions[ungrantedCron] = { id: ungrantedCron, origin: { kind: 'cron' } };
    const repo = makeRepo();
    const island = makeIsland(repo);
    for (const sessionId of [plainSession, channelSession, ungrantedCron]) {
      const result = island.requestPermission({
        type: 'file_write', tool: 'Write',
        details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
      });
      await flushMicrotasks();
      expect(await isStillPending(result)).toBe(true);
    }
    expect(repo.insert).toHaveBeenCalledTimes(3);
    island.drainPendingPermissions();
  });

  it('交互会话（未标 unattended）不触发授权查询，照常走交互审批路径', async () => {
    const sessionId = 'interactive-session';
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeRepo();
    const island = makeIsland(repo);
    const result = island.requestPermission({
      type: 'file_write', tool: 'Write',
      details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
    });
    await flushMicrotasks();
    // 交互路径：不停车（repo 不落行），Promise 等真人（60s 超时路径在别处已钉死）
    expect(repo.insert).not.toHaveBeenCalled();
    expect(await isStillPending(result)).toBe(true);
    island.drainPendingPermissions();
  });
});
