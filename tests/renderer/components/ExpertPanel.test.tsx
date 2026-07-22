// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listRolePacks = vi.fn<() => Promise<RolePackListItem[]>>();
const installRolePack = vi.fn();
const uninstallRolePack = vi.fn();
const retryRolePackMissingSkills = vi.fn();
const inviteExpert = vi.fn().mockResolvedValue(undefined);

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listRolePacks.mockResolvedValue([]);
  installRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  uninstallRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  retryRolePackMissingSkills.mockResolvedValue({ success: true, roleId: '云端产品顾问', installState: 'complete', missingSkills: [] });
});

describe('ExpertPanel', () => {
  it('「我的」渲染角色卡（花名/职业/记忆态），空记录显示未合作文案', async () => {
    listRoles.mockResolvedValue([
      makeEntry(),
      makeEntry({ roleId: '自定义客服', source: 'user', icon: undefined, displayName: undefined, profession: undefined, memoryCount: 2, lastWork: '整理了 FAQ' }),
    ]);
    render(<ExpertPanel />);
    await waitFor(() => {
      expect(screen.getByText('牧之')).toBeTruthy();
    });
    expect(screen.getByText('资深产品经理')).toBeTruthy();
    expect(screen.getByText('自定义客服')).toBeTruthy();
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
