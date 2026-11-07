// 已授权即不打扰（N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE 验收④）：
// 停车前的自动放行路径不得产生任何 needs-input 通知——授权覆盖的写请求直接放行，
// 不写停车台账、不发「有操作等你确认」。这里钉 schedule write grant 路径
//（standing grant 的消费在 toolExecutor.preAsk，见 toolExecutor.externalScopeNote.test.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

const notificationMocks = vi.hoisted(() => ({
  notifyNeedsInput: vi.fn(),
  retractNeedsInput: vi.fn(),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: notificationMocks,
}));

const writeGrantMocks = vi.hoisted(() => ({
  approveByScheduleWriteGrant: vi.fn<(request: unknown) => Promise<unknown>>(),
}));
vi.mock('../../../src/host/cron/cronWriteGrant', () => ({
  approveByScheduleWriteGrant: writeGrantMocks.approveByScheduleWriteGrant,
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeRepo(): PendingApprovalRepository & { insert: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { insert: ReturnType<typeof vi.fn> };
}

describe('schedule write grant 放行的请求不发 needs-input 通知', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    writeGrantMocks.approveByScheduleWriteGrant.mockReset();
    notificationMocks.notifyNeedsInput.mockClear();
  });

  afterEach(() => {
    resetPermissionModeManager();
  });

  it('授权界内 file_write 直接放行：不停车、不弹「有操作等你确认」', async () => {
    const sessionId = 'schedule-grant-no-alert';
    getPermissionModeManager().markUnattendedSession(sessionId);
    writeGrantMocks.approveByScheduleWriteGrant.mockResolvedValue({
      approved: true,
      approvalSource: 'schedule-write-grant',
    });
    const repo = makeRepo();
    const onEvent = vi.fn();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: repo,
    });

    await expect(island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/granted-folder/note.txt' },
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });

    expect(repo.insert).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(notificationMocks.notifyNeedsInput).not.toHaveBeenCalled();
  });
});
