// ============================================================================
// 云货架专家首跑：主 agent 轮起点的接线门
// ============================================================================
//
// dogfood 判 NO-GO 的根因是**钩错了路径**——标记挂在 subagentExecutor 上，
// 而用户选中专家聊天时专家是主 agent。所以这条门必须钉「主 agent 这一轮真的被钳了」，
// 光钉「标记被消费了」还会重蹈覆辙（PR #690 就是只测了台账侧）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = 'first-run-session';

const consumeFirstRunStrictMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/roleAssets/rolePackInstallService', () => ({
  consumeFirstRunStrict: consumeFirstRunStrictMock,
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ id: SESSION, messages: [], workingDirectory: '/tmp' }),
    updateSession: async () => undefined,
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({
    getSessionForkWorkspaceScope: vi.fn(() => null),
  })),
}));

import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getPermissionModeManager, permissionModeAutoApproves } from '../../../src/host/permissions/modes';



function createService(taskManager: unknown): AgentAppServiceImpl {
  return new AgentAppServiceImpl(
    () => taskManager as never,
    () => null,
    () => SESSION,
    vi.fn(),
  );
}

/** startTask 执行**期间**的有效档位——钳制必须在这一刻生效，不是跑完才生效。 */
function taskManagerCapturingModeDuringRun(seen: { mode?: string }) {
  return {
    startTask: vi.fn(async () => {
      seen.mode = getPermissionModeManager().getModeForSession(SESSION);
    }),
    getSessionStatus: vi.fn(),
    getOrCreateCurrentOrchestrator: () => ({
      getWorkingDirectory: () => '/tmp',
      setWorkingDirectory: () => undefined,
    }),
  };
}

describe('主 agent 轮起点的首跑钳制', () => {
  beforeEach(() => {
    consumeFirstRunStrictMock.mockReset();
    getPermissionModeManager().setSessionMode(SESSION, 'acceptEdits', true);
    getPermissionModeManager().clearFirstRunStrictSession(SESSION);
  });

  it('首跑：本轮执行期间免确认被摁掉，跑完解除', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(true);
    const seen: { mode?: string } = {};
    const service = createService(taskManagerCapturingModeDuringRun(seen));

    await service.sendMessage({
      content: '建个文件',
      sessionId: SESSION,
      context: { preferredAgentId: '岚析' },
    } as never);

    expect(consumeFirstRunStrictMock).toHaveBeenCalledWith('岚析');
    expect(permissionModeAutoApproves(seen.mode ?? '', 'write')).toBe(false);
    // 跑完必须解除，否则第二轮还被钳着（dogfood 要求两轮可见差别）
    expect(getPermissionModeManager().getModeForSession(SESSION)).toBe('acceptEdits');
  });

  it('非首跑：会话档原样生效，不误伤', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(false);
    const seen: { mode?: string } = {};
    const service = createService(taskManagerCapturingModeDuringRun(seen));

    await service.sendMessage({
      content: '建个文件',
      sessionId: SESSION,
      context: { preferredAgentId: '岚析' },
    } as never);

    expect(permissionModeAutoApproves(seen.mode ?? '', 'write')).toBe(true);
  });

  it('没选专家的普通对话不查台账', async () => {
    const seen: { mode?: string } = {};
    const service = createService(taskManagerCapturingModeDuringRun(seen));

    await service.sendMessage({ content: '你好', sessionId: SESSION } as never);

    expect(consumeFirstRunStrictMock).not.toHaveBeenCalled();
  });

  it('本轮抛错也要解除钳制（不能把会话永久锁在最严档）', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(true);
    const service = createService({
      startTask: vi.fn(async () => { throw new Error('boom'); }),
      getSessionStatus: vi.fn(),
      getOrCreateCurrentOrchestrator: () => ({
        getWorkingDirectory: () => '/tmp',
        setWorkingDirectory: () => undefined,
      }),
    });

    await expect(service.sendMessage({
      content: '建个文件',
      sessionId: SESSION,
      context: { preferredAgentId: '岚析' },
    } as never)).rejects.toThrow('boom');

    expect(getPermissionModeManager().getModeForSession(SESSION)).toBe('acceptEdits');
  });
});
