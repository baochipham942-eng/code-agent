// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const inviteExpert = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return { ...actual, listRoles: (...args: unknown[]) => listRoles(...(args as [])) };
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
