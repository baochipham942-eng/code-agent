import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';

let rawDb: BetterSqlite3.Database;
const roleAssetsMock = vi.hoisted(() => ({
  listPersistentRoles: vi.fn<() => Promise<string[]>>(),
}));
const agentRegistryMock = vi.hoisted(() => ({
  listAllAgents: vi.fn(),
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => rawDb }),
}));
vi.mock('../../../../src/host/services/roleAssets', () => ({
  BUILTIN_ROLE_IDS: ['牧之', '溯真'],
  listPersistentRoles: roleAssetsMock.listPersistentRoles,
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  listAllAgents: agentRegistryMock.listAllAgents,
}));

import { TeamRecipeService } from '../../../../src/host/services/team/teamRecipeService';
import { validateTeamRecipe, type TeamRecipe } from '../../../../src/shared/contract/teamRecipe';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function recipe(members: TeamRecipe['members'] = [{ roleId: '溯真', taskTemplate: '研究 {topic}' }]) {
  return {
    name: '我的配方',
    description: '测试',
    category: 'research' as const,
    members,
  };
}

describe('TeamRecipeService', () => {
  let db: Database.Database;
  let service: TeamRecipeService;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger() as never);
    rawDb = db;
    service = new TeamRecipeService();
    roleAssetsMock.listPersistentRoles.mockResolvedValue([]);
    agentRegistryMock.listAllAgents.mockReturnValue([{ id: '牧之' }, { id: '溯真' }]);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it.each([
    ['成员为空', recipe([]), 'members 不能为空'],
    ['角色不可解析', recipe([{ roleId: '不存在', taskTemplate: '研究 {topic}' }]), 'member roleId 不可解析：不存在'],
    ['成员键重复', recipe([
      { roleId: '溯真', taskTemplate: '研究 {topic}' },
      { roleId: '溯真', taskTemplate: '复核 {topic}' },
    ]), 'member 键重复：溯真'],
  ])('坏配方不落库：%s', async (_name, input, reason) => {
    await expect(service.create(input, 100)).rejects.toThrow(reason);
    expect(service.list()).toEqual([]);
  });

  it('无 lead 的专家小组配方能存取，合约校验返回空错误', async () => {
    const created = await service.create(recipe(), 100);

    expect(created.id).toMatch(/^user-/);
    expect(created.lead).toBeUndefined();
    expect(validateTeamRecipe(created, ['溯真'])).toEqual([]);
    expect(service.get(created.id)).toMatchObject({ id: created.id, lead: undefined, createdAt: 100, updatedAt: 100 });
  });

  it('允许引用自建持久化角色，并按传入时间戳更新', async () => {
    roleAssetsMock.listPersistentRoles.mockResolvedValue(['我的分析师']);
    agentRegistryMock.listAllAgents.mockReturnValue([{ id: '牧之' }, { id: '溯真' }, { id: '我的分析师' }]);
    const created = await service.create(recipe([{ roleId: '我的分析师', taskTemplate: '分析 {topic}' }]), 100);
    const updated = await service.update(created.id, {
      ...recipe([{ roleId: '我的分析师', taskTemplate: '复核 {topic}' }]),
      name: '更新后的配方',
    }, 200);

    expect(updated).toMatchObject({ id: created.id, createdAt: 100, updatedAt: 200, name: '更新后的配方' });
  });
});
