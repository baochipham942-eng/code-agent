import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SKILL_CATEGORIES } from '../../../../src/shared/constants/skillCatalog';

const config = vi.hoisted(() => ({ dir: '' }));
const service = vi.hoisted(() => ({ knownRoleIds: vi.fn(), create: vi.fn() }));
vi.mock('../../../../src/host/config/configPaths', () => ({ getUserConfigDir: () => config.dir }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../src/host/services/team/teamRecipeService', () => ({ getTeamRecipeService: () => service }));

import { proposeTeamRecipeModule } from '../../../../src/host/tools/modules/teamAuthoring/proposeTeamRecipe';
import { confirmTeamRecipeDraft, listTeamRecipeDrafts } from '../../../../src/host/services/team/teamRecipeDraftQueue';
import * as teamRecipeDraftQueue from '../../../../src/host/services/team/teamRecipeDraftQueue';

const allow = vi.fn(async () => ({ allow: true }));
function context() {
  return { sessionId: 'team-session', abortSignal: { aborted: false }, logger: { info: vi.fn() }, emit: vi.fn() };
}
function args(overrides: Record<string, unknown> = {}) {
  return { name: '研究冲刺', description: '把问题拆给专家', category: 'research', members: [{ roleId: '溯真', taskTemplate: '研究 {topic}' }], ...overrides };
}

describe('propose_team_recipe', () => {
  beforeEach(async () => {
    config.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-team-'));
    service.knownRoleIds.mockResolvedValue(new Set(['牧之', '溯真']));
    service.create.mockImplementation(async (recipe: Record<string, unknown>) => ({ ...recipe, id: 'user-confirmed' }));
  });
  afterEach(async () => { await fs.rm(config.dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it.each([
    ['成员为空', { members: [] }, 'members 不能为空'],
    ['角色不可解析', { members: [{ roleId: '不存在', taskTemplate: '研究 {topic}' }] }, 'member roleId 不可解析：不存在'],
    ['成员键重复', { members: [{ roleId: '溯真', taskTemplate: '研究 {topic}' }, { roleId: '溯真', taskTemplate: '复核 {topic}' }] }, 'member 键重复：溯真'],
  ])('校验失败不入队：%s', async (_caseName, patch, reason) => {
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args(patch), context() as never, allow as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(reason);
    expect(await listTeamRecipeDrafts()).toEqual([]);
  });

  it('变异钉：工具层 validate 拦住坏定义，不能把校验交给入队层', async () => {
    const enqueue = vi.spyOn(teamRecipeDraftQueue, 'enqueueTeamRecipeDraft').mockResolvedValue({ draft: null, reason: 'queue should not run' });
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args({ members: [] }), context() as never, allow as never);
    expect(result.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('不设 lead 仍能起草专家小组', async () => {
    const ctx = context();
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args(), ctx as never, allow as never);
    expect(result.ok).toBe(true);
    expect((ctx.emit as ReturnType<typeof vi.fn>).mock.calls[0][0].data.drafts[0].lead).toBeUndefined();
  });

  it('unresolvable-role code 出现时追加未知角色引导', async () => {
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args({ members: [{ roleId: '法务审核', taskTemplate: '审核 {topic}' }] }), context() as never, allow as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('法务审核');
    if (!result.ok) expect(result.error).toContain('本机没有对应专家');
  });

  it('非 unresolvable-role 校验错误不追加未知角色引导', async () => {
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args({ members: [] }), context() as never, allow as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('本机没有对应专家');
  });

  it('确认前不入库，确认后才创建配方', async () => {
    await (await proposeTeamRecipeModule.createHandler()).execute(args(), context() as never, allow as never);
    const [draft] = await listTeamRecipeDrafts();
    expect(service.create).not.toHaveBeenCalled();
    await expect(confirmTeamRecipeDraft(draft.id)).resolves.toMatchObject({ success: true, recipe: { id: 'user-confirmed' } });
    expect(service.create).toHaveBeenCalledOnce();
  });

  it.each(SKILL_CATEGORIES.map(({ id }) => id))('目录分类 %s 都可被接受', async (category) => {
    const result = await (await proposeTeamRecipeModule.createHandler()).execute(args({ name: `配方-${category}`, category }), context() as never, allow as never);
    expect(result.ok).toBe(true);
  });
});
