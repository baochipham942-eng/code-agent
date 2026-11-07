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
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import {
  isParkedApprovalClosureSentence,
  PARKED_APPROVAL_CLOSURE_SENTENCES,
} from '../../../src/shared/parkedApprovalClosure';

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

describe('24h 停车兜底与重启收口是同一句闭场话', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    notificationState.notifyNeedsInput.mockClear();
  });

  it('运行中 backstop 超时的 denied 文本 === 重启收口句子，renderer 精确匹配读作未执行', async () => {
    const repo = makeRepo();
    const sessionId = 'parked-expired-copy';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });
    const result: Promise<PermissionAskResult> = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/expired-copy.txt' },
      sessionId,
    });

    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.PARKED_APPROVAL);
    const backstop = await result;
    const restart = describeParkedApprovalClosure('expired_after_restart_24h');

    // 两条路径写出的必须一字不差：不管这 24 小时里应用有没有重启，用户看到同一句话。
    expect(backstop.message).toBe(restart);
    expect(backstop.message).toBe(PARKED_APPROVAL_CLOSURE_SENTENCES.expiredAfterRestart24h);
    // renderer（resolveParkedApprovalClosureCopy → isParkedApprovalClosureSentence）
    // 只有精确命中闭场句才按「未执行」呈现而不是「执行失败」。
    expect(isParkedApprovalClosureSentence(backstop.message)).toBe(true);
    expect(backstop).toEqual({ approved: false, denialSource: 'timeout', message: restart });
    // 台账行（重启后 renderer 重放的就是它）也带同一句。
    expect(repo.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: 'rejected',
      feedback: restart,
    }));
  });
});
