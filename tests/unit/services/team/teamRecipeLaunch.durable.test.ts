import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const sessionManagerMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  // launchTeamRecipe 起团队前落一条 user 请求消息（工具 checkpoint 的 sourceMessageId 锚点）
  addMessageToSession: vi.fn().mockResolvedValue(undefined),
}));
const executorMock = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerMock,
}));
vi.mock('../../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: executorMock.execute }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  listAllAgents: () => [{ id: '牧之' }, { id: '溯真' }, { id: '青禾' }],
}));
vi.mock('../../../../src/host/agent/agentDefinition', () => ({
  getPredefinedAgent: (id: string) => ({ id, name: id }),
  listPredefinedAgents: () => [{ id: '牧之' }, { id: '溯真' }, { id: '青禾' }],
  getAgentPrompt: () => 'test prompt',
  getAgentTools: () => ['Read'],
  getAgentMaxIterations: () => 1,
  getAgentPermissionPreset: () => 'default',
  getAgentMaxBudget: () => undefined,
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resetApplicationRunRegistryForTests, getApplicationRunRegistry } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { stableAgentTeamRunId } from '../../../../src/host/agent/agentTeamDurableAdapter';
import { resetParallelAgentCoordinators } from '../../../../src/host/agent/parallelAgentCoordinator';
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

describe('launchTeamRecipe durable parent', () => {
  let db: Database.Database;
  let repository: DurableRunRepository;

  beforeEach(() => {
    resetApplicationRunRegistryForTests();
    resetParallelAgentCoordinators();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new DurableRunRepository(db);
    repository.migrate();
    getApplicationRunRegistry().configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'test-host',
      processInstanceId: 'test-process',
      leaseDurationMs: 10_000,
    }));
    sessionManagerMock.getSession.mockResolvedValue({
      id: 'session-team-recipe',
      workingDirectory: '/repo',
      projectId: null,
      modelConfig: { provider: 'test', model: 'test-model' },
    });
    executorMock.execute.mockResolvedValue({
      success: true,
      output: 'done',
      toolsUsed: [],
      iterations: 1,
      duration: 1,
    });
  });

  afterEach(() => {
    resetParallelAgentCoordinators();
    resetApplicationRunRegistryForTests();
    db.close();
    vi.clearAllMocks();
  });

  it('creates a leased native parent, runs its durable team child, then terminals the parent', async () => {
    const launched = await launchTeamRecipe({
      sessionId: 'session-team-recipe',
      recipeId: 'product-spec',
      topic: '会员增长',
    });

    expect(launched).toEqual({ ok: true, runId: expect.stringMatching(/^team_recipe_/) });
    if (!launched.runId) throw new Error('expected parent run id');
    const parentRunId = launched.runId;
    const teamRunId = stableAgentTeamRunId(parentRunId, `${parentRunId}-team-recipe`);

    expect(await repository.get(parentRunId)).toMatchObject({
      engine: { kind: 'native' },
      owner: expect.objectContaining({ ownerId: 'test-host' }),
    });

    await eventually(async () => {
      expect((await repository.get(teamRunId))?.status).toBe('completed');
      expect((await repository.get(parentRunId))?.status).toBe('completed');
    });
  });
});
