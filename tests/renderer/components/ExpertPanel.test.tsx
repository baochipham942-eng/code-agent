// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail, RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';
import type { TeamRecipe } from '../../../src/shared/contract/teamRecipe';
import { teamEn, teamZh } from '../../../src/renderer/i18n/team';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listRolePacks = vi.fn<() => Promise<RolePackListItem[]>>();
const installRolePack = vi.fn();
const uninstallRolePack = vi.fn();
const retryRolePackMissingSkills = vi.fn();
const inviteExpert = vi.fn().mockResolvedValue(undefined);
const invokeDomain = vi.fn();
const listTeamRecipes = vi.fn<() => Promise<TeamRecipe[]>>();
const createTeamRecipe = vi.fn();
const updateTeamRecipe = vi.fn();
const deleteTeamRecipe = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return {
    ...actual,
    listRoles: (...args: unknown[]) => listRoles(...(args as [])),
    listRolePacks: (...args: unknown[]) => listRolePacks(...(args as [])),
    installRolePack: (...args: unknown[]) => installRolePack(...(args as [])),
    uninstallRolePack: (...args: unknown[]) => uninstallRolePack(...(args as [])),
    retryRolePackMissingSkills: (...args: unknown[]) => retryRolePackMissingSkills(...(args as [])),
  };
});

vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  inviteExpert: (...args: unknown[]) => inviteExpert(...args),
}));

vi.mock('../../../src/renderer/services/teamRecipeClient', () => ({
  listTeamRecipes: (...args: unknown[]) => listTeamRecipes(...(args as [])),
  createTeamRecipe: (...args: unknown[]) => createTeamRecipe(...args),
  updateTeamRecipe: (...args: unknown[]) => updateTeamRecipe(...args),
  deleteTeamRecipe: (...args: unknown[]) => deleteTeamRecipe(...args),
}));

import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';
import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function makeEntry(overrides: Partial<RolePanelEntry> = {}): RolePanelEntry {
  return {
    roleId: '牧之',
    description: '帮你把模糊想法磨成能评审、能开工的产品需求',
    source: 'builtin',
    memoryCount: 0,
    lastWork: null,
    icon: 'ClipboardList',
    category: 'product',
    displayName: '牧之',
    profession: '资深产品经理',
    tags: ['需求梳理', 'PRD 撰写'],
    quickPrompts: ['我有个产品想法，帮我梳理成需求清单'],
    ...overrides,
  };
}

function makeRolePack(overrides: Partial<RolePackListItem> = {}): RolePackListItem {
  return {
    entry: {
      roleId: '云端产品顾问',
      displayName: '云端产品顾问',
      description: '云端下发的产品专家',
      agentMd: '---\nname: 云端产品顾问\ntools: [Read, Glob]\n---\nPrompt',
      visual: { icon: 'ClipboardList', category: 'product', displayName: '云端产品顾问', profession: '产品顾问', tags: ['调研'], quickPrompts: [] },
      skills: [{ registryName: 'market-research' }, { registryName: 'pricing' }],
      packVersion: '1.2.0',
      publisher: 'Neo',
      reviewedAt: '2026-07-23',
      tags: ['调研'],
    },
    tools: ['Read', 'Glob'],
    installed: false,
    hasUpdate: false,
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<TeamRecipe> = {}): TeamRecipe {
  return {
    id: 'user-recipe-1',
    name: '我的调研配方',
    description: '两人各自找证据',
    category: 'research',
    members: [{ roleId: '牧之', taskTemplate: '研究 {topic}' }],
    ...overrides,
  };
}


function makeRoleDetail(overrides: Partial<RolePanelDetail> = {}): RolePanelDetail {
  return {
    roleId: '牧之',
    definition: '---\nname: 牧之\n---\n你是产品专家',
    definitionPath: '/roles/牧之.md',
    memories: [{ filename: 'preference.md', name: '用户偏好', description: '产品偏好', content: '关注交付质量', updatedAt: '2026-07-23' }],
    history: ['- 整理了需求评审稿'],
    proactivity: { level: 'silent' },
    visual: { displayName: '牧之', profession: '资深产品经理', icon: 'ClipboardList', category: 'product', tags: ['需求梳理', 'PRD 撰写'], quickPrompts: ['我有个产品想法，帮我梳理成需求清单'] },
    isBuiltin: true,
    equipment: { skills: ['research'], tools: ['Read'], model: 'balanced', maxIterations: 20, availableSkills: ['research', 'xlsx'], availableTools: ['Read', 'WebSearch'] },
    restore: { available: true },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listRolePacks.mockResolvedValue([]);
  listTeamRecipes.mockResolvedValue([]);
  createTeamRecipe.mockImplementation(async (recipe: Omit<TeamRecipe, 'id'>) => ({ ...recipe, id: 'user-copied' }));
  updateTeamRecipe.mockImplementation(async (recipeId: string, recipe: Omit<TeamRecipe, 'id'>) => ({ ...recipe, id: recipeId }));
  deleteTeamRecipe.mockResolvedValue(undefined);
  installRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  uninstallRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  retryRolePackMissingSkills.mockResolvedValue({ success: true, roleId: '云端产品顾问', installState: 'complete', missingSkills: [] });
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'detail') return Promise.resolve(makeRoleDetail());
    if (action === 'listBoundCronJobs') return Promise.resolve([]);
    if (action === 'listBindings') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});
describe('ExpertPanel', () => {
  it('「我的」渲染角色卡（花名/职业/记忆态），空记录显示未合作文案', async () => {
    listRoles.mockResolvedValue([
      makeEntry(),
      makeEntry({ roleId: '自定义客服', source: 'user', icon: undefined, displayName: '阿问', profession: '客服顾问', tags: ['FAQ 设计'], quickPrompts: ['帮我整理 FAQ，先找高频问题'], memoryCount: 2, lastWork: '整理了 FAQ' }),
    ]);
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    await waitFor(() => {
      expect(screen.getByText('牧之')).toBeTruthy();
    });
    expect(screen.getByText('资深产品经理')).toBeTruthy();
    expect(screen.getByText('阿问')).toBeTruthy();
    expect(screen.getByText('FAQ 设计')).toBeTruthy();
    expect(screen.getAllByText('可以直接开口')).toHaveLength(2);
    expect(screen.getByText(/2 条记忆/)).toBeTruthy();
    expect(screen.getByText('还没合作过')).toBeTruthy();
  });

  it('默认停在发现，并始终提供有明显样式的新建专家入口', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-tab-discover').getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByTestId('expert-tab-mine').getAttribute('aria-selected')).toBe('false');
    const create = screen.getByTestId('expert-create-role');
    expect(create.textContent).toContain('新建专家');
    expect(create.className).toContain('bg-zinc-600');
  });

  it('专家团词条不回潮为配方或 recipe', () => {
    expect(Object.values(teamZh.team).join('\n')).not.toContain('配方');
    expect(Object.values(teamEn.team).join('\n').toLowerCase()).not.toContain('recipe');
  });

  it('「发现」只展示内置专家，quickPrompt 点击以该句请 TA 来', async () => {
    listRoles.mockResolvedValue([
      makeEntry(),
      makeEntry({ roleId: '自定义客服', source: 'user', displayName: undefined }),
    ]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    expect(screen.queryByTestId('expert-card-自定义客服')).toBeNull();
    expect(screen.getByText('需求梳理')).toBeTruthy();

    fireEvent.click(screen.getByTestId('expert-quick-prompt'));
    expect(inviteExpert).toHaveBeenCalledWith('牧之', {
      seed: '我有个产品想法，帮我梳理成需求清单',
      title: '牧之',
    });
  });

  it('我的配方为空时给出空态引导，而不是把分区标题当正文重复一遍', async () => {
    listTeamRecipes.mockResolvedValue([]);
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    const empty = screen.getByTestId('team-my-recipes-empty');
    expect(empty.textContent).toContain('复制为我的');
    // 变异守卫：若空态退回渲染 t.team.myRecipes，这条会红（标题文案不含"复制为我的"）
    expect(empty.textContent).not.toBe('我的专家团');
  });

  it('组队区渲染出厂专家团和我的专家团，卡片按 lead 显示正确档位', async () => {
    listTeamRecipes.mockResolvedValue([makeRecipe()]);
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    expect(screen.getByText('出厂专家团')).toBeTruthy();
    expect(screen.getByText('我的专家团')).toBeTruthy();
    expect(screen.getByTestId('team-recipe-product-spec').textContent).toContain('专家团 · 主理人 牧之');
    expect(screen.getByTestId('team-recipe-user-recipe-1').textContent).toContain('专家小组 · 1 人各自作答');
    expect(within(screen.getByTestId('team-recipe-product-spec')).getByText('复制为我的')).toBeTruthy();
    expect(within(screen.getByTestId('team-recipe-user-recipe-1')).getByText('详情')).toBeTruthy();
  });

  it('复制出厂配方后调用 recipeCreate 并直接进入编辑器', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    fireEvent.click(within(screen.getByTestId('team-recipe-product-spec')).getByText('复制为我的'));
    await waitFor(() => expect(createTeamRecipe).toHaveBeenCalledWith(expect.objectContaining({ name: '产品规格' })));
    await waitFor(() => expect(screen.getByTestId('team-recipe-detail-user-copied')).toBeTruthy());
  });

  it('点出厂配方名进入只读详情，展示主理人和预计并发', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    fireEvent.click(screen.getByRole('button', { name: '详情 产品规格' }));
    expect(screen.getByTestId('team-recipe-detail-product-spec')).toBeTruthy();
    expect(screen.getByText('专家团 · 主理人 牧之')).toBeTruthy();
    expect(screen.getByText('预计并发 2 人')).toBeTruthy();
  });

  it('保存编辑配方调用 recipeUpdate，服务端校验错误显示具体原因', async () => {
    const recipe = makeRecipe();
    listTeamRecipes.mockResolvedValue([recipe]);
    updateTeamRecipe.mockRejectedValue(new Error('member 牧之 的 taskTemplate 为空'));
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    fireEvent.click(within(screen.getByTestId('team-recipe-user-recipe-1')).getByText('详情'));
    fireEvent.click(screen.getByTestId('team-recipe-save'));
    await waitFor(() => expect(updateTeamRecipe).toHaveBeenCalledWith('user-recipe-1', expect.anything()));
    expect((await screen.findByRole('alert')).textContent).toContain('member 牧之 的 taskTemplate 为空');
  });

  it('不设主理人的专家小组可保存', async () => {
    const recipe = makeRecipe();
    listTeamRecipes.mockResolvedValue([recipe]);
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    fireEvent.click(within(screen.getByTestId('team-recipe-user-recipe-1')).getByText('详情'));
    fireEvent.click(screen.getByTestId('team-recipe-save'));
    await waitFor(() => expect(updateTeamRecipe).toHaveBeenCalledWith('user-recipe-1', expect.objectContaining({ lead: undefined })));
  });

  it('删除我的配方要二次确认才调用 recipeDelete', async () => {
    listTeamRecipes.mockResolvedValue([makeRecipe()]);
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    fireEvent.click(within(screen.getByTestId('team-recipe-user-recipe-1')).getByText('删除'));
    expect(deleteTeamRecipe).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByText('确认删除这个专家团？').parentElement!).getByText('删除'));
    await waitFor(() => expect(deleteTeamRecipe).toHaveBeenCalledWith('user-recipe-1'));
  });

  it('「请 TA 来」按钮不带 seed 只建绑定会话', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByText('牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-invite-牧之'));
    expect(inviteExpert).toHaveBeenCalledWith('牧之', { seed: undefined, title: '牧之' });
  });


  it('点「详情」请求打开独立全屏详情页', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-detail-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-detail-牧之'));
    cleanup();
    render(<RoleDetailPage roleId="牧之" />);
    await waitFor(() => expect(screen.getByTestId('role-detail-page-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('role-detail-tab-records'));
    expect(screen.getByText('用户偏好')).toBeTruthy();
    expect(screen.getByText('整理了需求评审稿')).toBeTruthy();
    expect(screen.getByTestId('role-bindings-section')).toBeTruthy();
    expect(screen.getByTestId('role-bound-automations-empty').textContent).toContain('这个角色还没有绑定的自动化');

    expect(screen.getByTestId('role-detail-records-tab')).toBeTruthy();
  });

  it('独立详情页的四个 tab 都可切换，关闭回到能力中心专家 tab', async () => {
    useAppStore.getState().openExpertRoleDetail('牧之');
    render(<RoleDetailPage roleId="牧之" />);
    await waitFor(() => expect(screen.getByTestId('role-detail-basic-tab')).toBeTruthy());
    fireEvent.click(screen.getByTestId('role-detail-tab-skills'));
    expect(screen.getByTestId('role-detail-equipment-tab')).toBeTruthy();
    fireEvent.click(screen.getByTestId('role-detail-tab-persona'));
    expect(screen.getByTestId('role-detail-persona-tab')).toBeTruthy();
    fireEvent.click(screen.getByTestId('role-detail-tab-records'));
    expect(screen.getByTestId('role-detail-records-tab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(useAppStore.getState().showCapabilityHub).toBe(true);
    expect(useAppStore.getState().capabilityHubTab).toBe('experts');
  });

  it('详情页为空时展示绑定自动化空态；有任务时展示调度、状态和主动性管理标注', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'detail') return Promise.resolve(makeRoleDetail());
      if (action === 'listBindings') return Promise.resolve([]);
      if (action === 'listBoundCronJobs') return Promise.resolve([
        { id: 'daily-report', name: '日报', schedule: { type: 'every', interval: 1, unit: 'days' }, enabled: true, nextRunAt: 1_800_000_000_000, actionType: 'agent' },
        { id: 'wake', name: '主动巡检', schedule: { type: 'cron', expression: '0 9 * * *' }, enabled: false, actionType: 'role_wake' },
      ]);
      return Promise.resolve(undefined);
    });
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-detail-牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-detail-牧之'));
    cleanup();
    render(<RoleDetailPage roleId="牧之" />);
    fireEvent.click(screen.getByTestId('role-detail-tab-records'));
    await waitFor(() => expect(screen.getByTestId('role-bound-automations-list')).toBeTruthy());
    expect(screen.getByTestId('role-bound-automation-daily-report').textContent).toContain('每 1 天');
    expect(screen.getByTestId('role-bound-automation-daily-report').textContent).toContain('启用');
    expect(screen.getByTestId('role-bound-automation-managed-wake').textContent).toContain('由上方「主动性」设置管理');
  });

  it('保存基本信息后详情立即换成新花名，返回卡片也使用更新后的展示字段', async () => {
    let saved = false;
    const customEntry = (overrides: Partial<RolePanelEntry> = {}) => makeEntry({ roleId: '自定义专家', source: 'user', displayName: '初始名', profession: '初始职业', ...overrides });
    listRoles.mockImplementation(async () => [customEntry(saved ? { displayName: '小满', profession: '增长顾问' } : {})]);
    invokeDomain.mockImplementation((_domain: string, action: string, payload?: { visual?: Record<string, unknown> }) => {
      if (action === 'detail') return Promise.resolve(makeRoleDetail({ roleId: '自定义专家', isBuiltin: false, visual: saved ? { displayName: '小满', profession: '增长顾问', tags: ['增长'], quickPrompts: ['帮我看增长，给建议'] } : { displayName: '初始名', profession: '初始职业' } }));
      if (action === 'updateVisual') {
        saved = true;
        return Promise.resolve(payload?.visual);
      }
      if (action === 'listBindings') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    await waitFor(() => expect(screen.getByTestId('expert-detail-自定义专家')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-detail-自定义专家'));
    cleanup();
    render(<RoleDetailPage roleId="自定义专家" />);
    await waitFor(() => expect(screen.getByText('基本信息')).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue('初始名'), { target: { value: '小满' } });
    fireEvent.change(screen.getByDisplayValue('初始职业'), { target: { value: '增长顾问' } });
    fireEvent.click(screen.getByRole('button', { name: '保存基本信息' }));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'updateVisual', expect.objectContaining({ roleId: '自定义专家', visual: expect.objectContaining({ displayName: '小满', profession: '增长顾问' }) })));
    await waitFor(() => expect(screen.getAllByText('小满').length).toBeGreaterThan(0));

    expect(screen.getByText('小满')).toBeTruthy();
  });

  it('装备和正文走独立 IPC 保存；自建角色没有还原出厂入口', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string, payload?: Record<string, unknown>) => {
      if (action === 'detail') return Promise.resolve(makeRoleDetail({ roleId: '自定义专家', isBuiltin: false, restore: undefined }));
      if (action === 'listBindings') return Promise.resolve([]);
      if (action === 'updateEquipment' || action === 'updateDefinitionBody') return Promise.resolve(payload);
      return Promise.resolve(undefined);
    });
    listRoles.mockResolvedValue([makeEntry({ roleId: '自定义专家', source: 'user' })]);
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    await waitFor(() => expect(screen.getByTestId('expert-detail-自定义专家')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-detail-自定义专家'));
    cleanup();
    render(<RoleDetailPage roleId="自定义专家" />);
    fireEvent.click(screen.getByTestId('role-detail-tab-skills'));
    await waitFor(() => expect(screen.getByTestId('role-equipment-editor')).toBeTruthy());
    expect(screen.queryByTestId('role-restore-factory')).toBeNull();

    // 技能页只改技能；档位归模型页，保存时必须原样带回（否则换技能会把模型选择冲掉）
    fireEvent.click(screen.getByLabelText('xlsx'));
    fireEvent.click(screen.getByTestId('role-equipment-save'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'updateEquipment', expect.objectContaining({ roleId: '自定义专家', equipment: expect.objectContaining({ skills: ['research', 'xlsx'], model: 'balanced' }) })));

    fireEvent.click(screen.getByTestId('role-detail-tab-model'));
    await waitFor(() => expect(screen.getByTestId('role-model-tier-powerful')).toBeTruthy());
    fireEvent.click(screen.getByTestId('role-model-tier-powerful'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'updateEquipment', expect.objectContaining({ roleId: '自定义专家', equipment: expect.objectContaining({ skills: ['research'], model: 'powerful', modelOverride: null }) })));

    fireEvent.click(screen.getByTestId('role-detail-tab-persona'));
    fireEvent.change(screen.getByTestId('role-definition-body'), { target: { value: '新的角色正文' } });
    fireEvent.click(screen.getByTestId('role-definition-save'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'updateDefinitionBody', { roleId: '自定义专家', body: '新的角色正文' }));
  });

  it('云包角色在本地改过时显示不会被更新覆盖的提示', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'detail') return Promise.resolve(makeRoleDetail({ roleId: '云端产品顾问', isBuiltin: false, locallyModified: true, restore: { available: false, disabledReason: '当前无法取得云端出厂定义' } }));
      if (action === 'listBindings') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    listRoles.mockResolvedValue([makeEntry({ roleId: '云端产品顾问', source: 'user' })]);
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    await waitFor(() => expect(screen.getByTestId('expert-detail-云端产品顾问')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-detail-云端产品顾问'));
    cleanup();
    render(<RoleDetailPage roleId="云端产品顾问" />);
    // 「本地已改过」提示在基本信息 tab；「还原出厂」随人设正文一起住在人设 tab
    await waitFor(() => expect(screen.getByTestId('role-locally-modified').textContent).toContain('后续更新不会覆盖'));
    fireEvent.click(screen.getByTestId('role-detail-tab-persona'));
    expect((await screen.findByTestId('role-restore-factory') as HTMLButtonElement).disabled).toBe(true);
  });

  it('空列表渲染空态', async () => {
    listRoles.mockResolvedValue([]);
    render(<ExpertPanel />);
    await waitFor(() => {
      expect(screen.getByText(/还没有专家/)).toBeTruthy();
    });
  });

  it('退化角色包在货架和「我的」专家卡显示不可用技能清单', async () => {
    const degraded = makeRolePack({ installed: true, installState: 'degraded', missingSkills: ['pricing'] });
    listRoles.mockResolvedValue([makeEntry({ roleId: '云端产品顾问', source: 'user', displayName: '云端产品顾问' })]);
    listRolePacks.mockResolvedValue([degraded]);
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));

    await waitFor(() => expect(screen.getByTestId('role-pack-degraded-云端产品顾问')).toBeTruthy());
    expect(screen.getByTestId('expert-card-云端产品顾问')).toBeTruthy();
    expect(screen.getByTestId('role-pack-missing-skills-云端产品顾问').textContent).toContain('pricing');
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    expect(screen.getByTestId('role-pack-card-云端产品顾问')).toBeTruthy();
    expect(screen.getByTestId('role-pack-degraded-云端产品顾问')).toBeTruthy();
    expect(screen.getByTestId('role-pack-missing-skills-云端产品顾问').textContent).toContain('pricing');
  });

  it('重试补装后刷新货架并移除退化标记', async () => {
    const degraded = makeRolePack({ installed: true, installState: 'degraded', missingSkills: ['pricing'] });
    const complete = makeRolePack({ installed: true, installState: 'complete', missingSkills: [] });
    listRoles.mockResolvedValue([makeEntry({ roleId: '云端产品顾问', source: 'user', displayName: '云端产品顾问' })]);
    listRolePacks.mockResolvedValueOnce([degraded]).mockResolvedValueOnce([complete]);
    render(<ExpertPanel />);

    await waitFor(() => expect(screen.getByTestId('role-pack-retry-missing-云端产品顾问')).toBeTruthy());
    fireEvent.click(screen.getByTestId('role-pack-retry-missing-云端产品顾问'));
    await waitFor(() => expect(retryRolePackMissingSkills).toHaveBeenCalledWith('云端产品顾问'));
    await waitFor(() => expect(screen.queryByTestId('role-pack-degraded-云端产品顾问')).toBeNull());
  });

  it('显示本地改动提示，并在有新版时提供升级', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    listRolePacks.mockResolvedValue([makeRolePack({ installed: true, locallyModified: true, hasUpdate: true })]);
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-discover'));

    await waitFor(() => expect(screen.getByTestId('role-pack-locally-modified-云端产品顾问').textContent).toContain('更新不会覆盖'));
    expect(screen.getByTestId('role-pack-upgrade-云端产品顾问').textContent).toContain('升级');
  });

  it('货架拉取失败只显示可重试空态，不暴露诊断码', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    listRolePacks.mockRejectedValue(new Error('public_keys_missing'));
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-discover'));

    await waitFor(() => expect(screen.getByTestId('role-pack-load-error')).toBeTruthy());
    expect(screen.getByTestId('role-pack-load-error').textContent).not.toContain('public_keys_missing');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
