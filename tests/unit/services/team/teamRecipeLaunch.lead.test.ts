import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  addMessageToSession: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  getOrCreateCurrentOrchestrator: vi.fn(),
  buildRoleContextBlock: vi.fn(),
  archiveText: vi.fn(),
  listRuns: vi.fn(),
  launchAgentTeam: vi.fn(),
}));

vi.mock('../../../../src/shared/constants/teamRecipeCatalog', () => ({
  TEAM_RECIPES: [{
    id: 'lead-recipe',
    name: '主理人配方',
    description: '测试主理人路径',
    category: 'product',
    lead: { roleId: '牧之', briefTemplate: '围绕 {topic} 形成最终规格。' },
    members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }],
  }],
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: mocks.getSession,
    addMessageToSession: mocks.addMessageToSession,
  }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  listAllAgents: () => [{ id: '牧之' }, { id: '溯真' }],
}));
vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({ getOrCreateCurrentOrchestrator: mocks.getOrCreateCurrentOrchestrator }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: mocks.buildRoleContextBlock,
}));
vi.mock('../../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => ({ archiveText: mocks.archiveText }),
}));
vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => ({ getSwarmTraceRepo: () => ({ listRuns: mocks.listRuns }) }),
}));
vi.mock('../../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  launchAgentTeam: mocks.launchAgentTeam,
}));

import { resetApplicationRunRegistryForTests, getApplicationRunRegistry } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { buildLeadBrief, launchTeamRecipe } from '../../../../src/host/services/team/teamRecipeLaunchService';

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

describe('team recipe lead orchestrator', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetApplicationRunRegistryForTests();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    getApplicationRunRegistry().configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'test-host',
      processInstanceId: 'test-process',
      leaseDurationMs: 10_000,
    }));
    mocks.getSession.mockResolvedValue({
      id: 'session-lead',
      workingDirectory: '/repo',
      projectId: 'project-1',
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [{ role: 'assistant', content: '成员汇报后的主理人定稿' }],
    });
    mocks.getOrCreateCurrentOrchestrator.mockReturnValue({ sendMessage: mocks.sendMessage });
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.buildRoleContextBlock.mockResolvedValue('角色上下文');
    mocks.listRuns.mockReturnValue([{ sessionId: 'session-lead', startedAt: Date.now() + 10_000, completedCount: 1 }]);
    mocks.launchAgentTeam.mockResolvedValue({ success: true, output: '确定性聚合稿' });
  });

  afterEach(() => {
    resetApplicationRunRegistryForTests();
    db.close();
    vi.clearAllMocks();
  });

  it('buildLeadBrief 注入填好 topic 的成员 JSON 和首步并行起团铁律', () => {
    const brief = buildLeadBrief({
      id: 'brief', name: '简报', description: '', category: 'product',
      lead: { roleId: '牧之', briefTemplate: '主题是 {topic}' },
      members: [{ roleId: '溯真', taskTemplate: '核验 {topic}' }],
    }, '会员增长');

    expect(brief).toContain('主题是 会员增长');
    expect(brief).toContain('第一步必须调用 spawn_agent，parallel=true');
    expect(brief).toContain('禁止你自己代写成员的专业产出');
    expect(brief).toContain('"role": "溯真"');
    expect(brief).toContain('"task": "核验 会员增长"');
  });

  it('主理人轮完成成员验真后归档定稿', async () => {
    await expect(launchTeamRecipe({ sessionId: 'session-lead', recipeId: 'lead-recipe', topic: '会员增长' }))
      .resolves.toEqual({ ok: true, sessionId: 'session-lead' });

    await eventually(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(expect.stringContaining('agents JSON'), undefined, {
        mode: 'normal', agentOverrideId: '牧之', turnSystemContext: ['角色上下文'],
      });
      expect(mocks.archiveText).toHaveBeenCalledWith({
        projectId: 'project-1', title: '主理人配方·会员增长', text: '成员汇报后的主理人定稿',
        tags: ['定稿'], sourceSessionId: 'session-lead',
      });
    });
    expect(mocks.launchAgentTeam).not.toHaveBeenCalled();
    // sendMessage 自己会落 user 消息；再补一条会让会话出现两条组队起点
    expect(mocks.addMessageToSession).not.toHaveBeenCalled();
  });

  it('成员已跑但主理人无定稿：只报警不重跑团队（避免二次全额付费）', async () => {
    mocks.getSession.mockResolvedValue({
      id: 'session-lead',
      workingDirectory: '/repo',
      projectId: 'project-1',
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [{ role: 'assistant', content: '   ' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await launchTeamRecipe({ sessionId: 'session-lead', recipeId: 'lead-recipe', topic: '会员增长' });

    await eventually(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('不重跑团队')));
    expect(mocks.launchAgentTeam).not.toHaveBeenCalled();
    expect(mocks.archiveText).not.toHaveBeenCalled();
  });

  it('铁律校验查询抛错时按已跑处理，照常归档且不重跑团队', async () => {
    mocks.listRuns.mockImplementation(() => { throw new Error('db down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await launchTeamRecipe({ sessionId: 'session-lead', recipeId: 'lead-recipe', topic: '会员增长' });

    await eventually(() => expect(mocks.archiveText).toHaveBeenCalled());
    expect(mocks.launchAgentTeam).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('按已跑处理'), expect.any(Error));
  });

  it('零成员 run 丢弃主理人稿并降级', async () => {
    mocks.listRuns.mockReturnValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await launchTeamRecipe({ sessionId: 'session-lead', recipeId: 'lead-recipe', topic: '会员增长' });

    await eventually(() => expect(mocks.launchAgentTeam).toHaveBeenCalled());
    expect(mocks.archiveText).not.toHaveBeenCalledWith(expect.objectContaining({ text: '成员汇报后的主理人定稿' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未发现本轮已完成成员 run'));
  });

  it('主理人轮抛错时降级并记录原因', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('lead failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await launchTeamRecipe({ sessionId: 'session-lead', recipeId: 'lead-recipe', topic: '会员增长' });

    await eventually(() => expect(mocks.launchAgentTeam).toHaveBeenCalled());
    expect(warn).toHaveBeenCalledWith('[TeamRecipe] 主理人降级：主会话轮执行失败', expect.any(Error));
  });
});
