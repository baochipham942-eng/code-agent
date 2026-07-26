import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  addMessageToSession: vi.fn(),
  patchSessionMetadata: vi.fn(),
  sendMessage: vi.fn(),
  getOrCreateCurrentOrchestrator: vi.fn(),
  buildRoleContextBlock: vi.fn(),
  launchAgentTeam: vi.fn(),
  archiveText: vi.fn(),
  spawnGuardList: vi.fn(),
  listRuns: vi.fn(),
  startDurable: vi.fn(),
  terminalDurable: vi.fn(),
}));

const recipes = vi.hoisted(() => ({
  withLead: {
    id: 'with-lead',
    name: '主理人配方',
    description: '有主理人',
    category: 'product',
    lead: { roleId: '牧之', briefTemplate: '统筹 {topic}' },
    members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }],
  },
  withoutLead: {
    id: 'without-lead',
    name: '无主理人配方',
    description: '成员自行协作',
    category: 'product',
    members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }],
  },
}));

const durableRegistry = vi.hoisted(() => ({
  terminalDurable: mocks.terminalDurable,
}));

vi.mock('../../../../src/shared/constants/teamRecipeCatalog', () => ({ TEAM_RECIPES: [] }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: mocks.getSession,
    addMessageToSession: mocks.addMessageToSession,
    patchSessionMetadata: mocks.patchSessionMetadata,
  }),
}));
vi.mock('../../../../src/host/services/team/teamRecipeService', () => ({
  getTeamRecipeService: () => ({
    get: (recipeId: string) => recipeId === recipes.withLead.id
      ? recipes.withLead
      : recipeId === recipes.withoutLead.id
        ? recipes.withoutLead
        : undefined,
  }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  listAllAgents: () => [{ id: '牧之' }, { id: '溯真' }],
}));
vi.mock('../../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => durableRegistry,
  getApplicationRunRegistry: () => ({
    waitForDurableKernel: vi.fn().mockResolvedValue(true),
    startDurable: mocks.startDurable,
  }),
}));
vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: mocks.getOrCreateCurrentOrchestrator,
  }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: mocks.buildRoleContextBlock,
}));
vi.mock('../../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({ list: mocks.spawnGuardList }),
}));
vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => ({
    getSwarmTraceRepo: () => ({ listRuns: mocks.listRuns }),
  }),
}));
vi.mock('../../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  launchAgentTeam: mocks.launchAgentTeam,
}));
vi.mock('../../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => ({ archiveText: mocks.archiveText }),
}));

import { launchTeamRecipe } from '../../../../src/host/services/team/teamRecipeLaunchService';

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('team recipe lead metadata persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      id: 'session-team',
      workingDirectory: '/repo',
      projectId: 'project-1',
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [{ role: 'assistant', content: '主理人定稿' }],
    });
    mocks.patchSessionMetadata.mockResolvedValue(true);
    mocks.addMessageToSession.mockResolvedValue(undefined);
    mocks.getOrCreateCurrentOrchestrator.mockReturnValue({ sendMessage: mocks.sendMessage });
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.buildRoleContextBlock.mockResolvedValue('角色上下文');
    mocks.spawnGuardList.mockReturnValue([]);
    mocks.listRuns.mockReturnValue([{
      sessionId: 'session-team',
      startedAt: Number.MAX_SAFE_INTEGER,
      completedCount: 1,
    }]);
    mocks.startDurable.mockResolvedValue({ context: { runId: 'parent-run' } });
    mocks.terminalDurable.mockResolvedValue(undefined);
    mocks.launchAgentTeam.mockResolvedValue({ success: true, output: '确定性聚合稿' });
  });

  it('有 lead 的配方发起时写入会话级 teamLead marker', async () => {
    await expect(launchTeamRecipe({
      sessionId: 'session-team',
      recipeId: 'with-lead',
      topic: '会员增长',
    })).resolves.toEqual({ ok: true, sessionId: 'session-team' });

    expect(mocks.patchSessionMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.patchSessionMetadata).toHaveBeenCalledWith('session-team', {
      teamLead: {
        roleId: '牧之',
        recipeId: 'with-lead',
        setAt: expect.any(Number),
      },
    });
  });

  it('无 lead 的配方不写 teamLead，也不把第一个成员当默认 lead', async () => {
    await expect(launchTeamRecipe({
      sessionId: 'session-team',
      recipeId: 'without-lead',
      topic: '会员增长',
    })).resolves.toEqual({ ok: true, runId: 'parent-run' });

    expect(mocks.patchSessionMetadata).not.toHaveBeenCalled();
  });

  it('主理人轮失败降级到 deterministic 时仍保留已写入的 lead', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('lead failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await launchTeamRecipe({
      sessionId: 'session-team',
      recipeId: 'with-lead',
      topic: '会员增长',
    });

    await eventually(() => expect(mocks.launchAgentTeam).toHaveBeenCalledTimes(1));
    expect(mocks.patchSessionMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.patchSessionMetadata).toHaveBeenCalledWith(
      'session-team',
      expect.objectContaining({
        teamLead: expect.objectContaining({ roleId: '牧之', recipeId: 'with-lead' }),
      }),
    );
    expect(mocks.patchSessionMetadata.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.launchAgentTeam.mock.invocationCallOrder[0]);
  });
});
