// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail, RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listRolePacks = vi.fn<() => Promise<RolePackListItem[]>>();
const installRolePack = vi.fn();
const uninstallRolePack = vi.fn();
const retryRolePackMissingSkills = vi.fn();
const inviteExpert = vi.fn().mockResolvedValue(undefined);
const invokeDomain = vi.fn();

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

import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';

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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listRolePacks.mockResolvedValue([]);
  installRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  uninstallRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  retryRolePackMissingSkills.mockResolvedValue({ success: true, roleId: '云端产品顾问', installState: 'complete', missingSkills: [] });
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'detail') return Promise.resolve(makeRoleDetail());
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

  it('「发现」配方卡显示主理人', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-card-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    expect(screen.getByTestId('team-recipe-product-spec').textContent).toContain('主理人 · 牧之');
  });

  it('「请 TA 来」按钮不带 seed 只建绑定会话', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByText('牧之')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-invite-牧之'));
    expect(inviteExpert).toHaveBeenCalledWith('牧之', { seed: undefined, title: '牧之' });
  });


  it('点「详情」在同页展示共享详情组件，返回后回到专家卡片网格', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    render(<ExpertPanel />);
    await waitFor(() => expect(screen.getByTestId('expert-detail-牧之')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-detail-牧之'));
    await waitFor(() => expect(screen.getByTestId('role-detail-page-牧之')).toBeTruthy());
    expect(screen.getByText('用户偏好')).toBeTruthy();
    expect(screen.getByText('整理了需求评审稿')).toBeTruthy();
    expect(screen.getByTestId('role-bindings-section')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByTestId('expert-card-牧之')).toBeTruthy();
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
    await waitFor(() => expect(screen.getByTestId('expert-detail-自定义专家')).toBeTruthy());
    fireEvent.click(screen.getByTestId('expert-detail-自定义专家'));
    await waitFor(() => expect(screen.getByText('基本信息')).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue('初始名'), { target: { value: '小满' } });
    fireEvent.change(screen.getByDisplayValue('初始职业'), { target: { value: '增长顾问' } });
    fireEvent.click(screen.getByRole('button', { name: '保存基本信息' }));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'updateVisual', expect.objectContaining({ roleId: '自定义专家', visual: expect.objectContaining({ displayName: '小满', profession: '增长顾问' }) })));
    await waitFor(() => expect(screen.getAllByText('小满').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(screen.getByTestId('expert-card-自定义专家').textContent).toContain('小满'));
    expect(screen.getByTestId('expert-card-自定义专家').textContent).toContain('增长顾问');
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
