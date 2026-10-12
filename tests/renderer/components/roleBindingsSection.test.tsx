// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpertContextBinding } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

// skill 目录走 skill:list（skill 绑定行展示名解析用）：mock 掉，真实实现只读路径不抛错
vi.mock('../../../src/renderer/services/invokeSkillIPC', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/services/invokeSkillIPC')>()),
  invokeSkillIPC: vi.fn(),
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([
    { id: 'lib_1', projectId: null, title: '产品语境卡', kind: 'upload', pathOrUri: '/x', tags: [], createdAt: 1, updatedAt: 1 },
  ]),
}));

import { RoleBindingsSection } from '../../../src/renderer/components/features/settings/tabs/RoleBindingsSection';
import { invokeSkillIPC } from '../../../src/renderer/services/invokeSkillIPC';

function makeBinding(overrides: Partial<ExpertContextBinding> = {}): ExpertContextBinding {
  return {
    id: 'bind_1',
    kind: 'file',
    target: '/Users/x/PRD 模板.md',
    title: 'PRD 模板.md',
    mode: 'on_demand',
    createdAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // skill 目录默认「取不到」（真实 invokeSkillIPC 失败时也是返回 undefined）
  vi.mocked(invokeSkillIPC).mockResolvedValue(undefined);
});

describe('RoleBindingsSection', () => {
  it('空资料架渲染空态', async () => {
    invokeDomain.mockResolvedValue([]);
    render(<RoleBindingsSection roleId="牧之" />);
    await waitFor(() => {
      expect(screen.getByText(/还没有绑定资料/)).toBeTruthy();
    });
    expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'listBindings', { roleId: '牧之' });
  });

  it('渲染绑定条目（标题 + 模式标签）并可移除；不再有范围选择器', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') return Promise.resolve([makeBinding()]);
      return Promise.resolve({ removed: true });
    });
    render(<RoleBindingsSection roleId="牧之" />);
    await waitFor(() => {
      expect(screen.getByText('PRD 模板.md')).toBeTruthy();
    });
    expect(screen.getAllByText('按需').length).toBeGreaterThan(0);
    expect(screen.queryByText('私有')).toBeNull();

    fireEvent.click(screen.getByTitle('移除'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'removeBinding', { roleId: '牧之', bindingId: 'bind_1' });
    });
  });

  it('从资料库绑定走 addBinding（带当前 mode，不带 scope）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') return Promise.resolve([]);
      return Promise.resolve(makeBinding({ kind: 'library_item', target: 'lib_1' }));
    });
    render(<RoleBindingsSection roleId="牧之" />);
    await waitFor(() => {
      expect(screen.getByTestId('role-binding-library-select')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('role-binding-library-select'), { target: { value: 'lib_1' } });
    fireEvent.click(screen.getByTestId('role-binding-add-library'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'addBinding', {
        roleId: '牧之',
        kind: 'library_item',
        target: 'lib_1',
        mode: 'always',
      });
    });
  });

  // ---- skill 绑定行的可读展示（2026-10-11 收集方返修：raw slug 对非程序员不可读） ----

  // SKILL_LIST 返回行的最小完整形状（ParsedSkill 必填字段 + IPC 回填的三个开关位）
  const catalogSkill = (name: string, description: string) => ({
    name,
    description,
    promptContent: '',
    basePath: `/skills/${name}`,
    allowedTools: [] as string[],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline' as const,
    source: 'builtin' as const,
    globalEnabled: true,
    projectOverride: null,
    enabled: true,
  });

  const SKILL_CATALOG = [
    catalogSkill('brainstorming', '动手前先梳理意图、需求与设计'),
    catalogSkill('data-cleaning', '系统性数据清洗与分析 — 处理 Excel/CSV 数据时自动使用，覆盖去重、缺失值、异常值修正'),
  ];

  it('skill 绑定行展示可读展示名而非英文 slug（slug 只留在悬浮提示）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') {
        return Promise.resolve([
          makeBinding({ id: 'bind_s1', kind: 'skill', target: 'brainstorming', title: 'brainstorming', mode: 'always' }),
          makeBinding({ id: 'bind_s2', kind: 'skill', target: 'data-cleaning', title: 'data-cleaning', mode: 'always' }),
        ]);
      }
      return Promise.resolve({ removed: true });
    });
    vi.mocked(invokeSkillIPC).mockResolvedValue(SKILL_CATALOG);

    render(<RoleBindingsSection roleId="牧之" />);

    // 可见标题 = 目录解析出的展示名（描述首句），slug 只作为 title 悬浮提示存在
    await waitFor(() => {
      expect(screen.getByTitle('brainstorming').textContent).toBe('动手前先梳理意图、需求与设计');
    });
    expect(screen.getByTitle('data-cleaning').textContent).toBe('系统性数据清洗与分析');
    expect(screen.queryByText('brainstorming')).toBeNull();
    expect(screen.queryByText('data-cleaning')).toBeNull();
    // 模式标签保留；scope 标签已整体下线（main 674335e24），任何行都不显示「私有」
    expect(within(screen.getByTestId('role-binding-bind_s1')).getByText('常驻索引')).toBeTruthy();
    expect(within(screen.getByTestId('role-binding-bind_s2')).getByText('常驻索引')).toBeTruthy();
    expect(screen.queryByText('私有')).toBeNull();
  });

  it('混合场景：资料类与 skill 行都不显示「私有」标签（scope 徽标已整体下线）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') {
        return Promise.resolve([
          makeBinding({ id: 'bind_f1', target: '/Users/x/PRD 模板.md', title: 'PRD 模板.md' }),
          makeBinding({ id: 'bind_s1', kind: 'skill', target: 'brainstorming', title: 'brainstorming', mode: 'always' }),
        ]);
      }
      return Promise.resolve({ removed: true });
    });
    vi.mocked(invokeSkillIPC).mockResolvedValue(SKILL_CATALOG);

    render(<RoleBindingsSection roleId="牧之" />);

    await waitFor(() => {
      expect(screen.getByTitle('brainstorming').textContent).toBe('动手前先梳理意图、需求与设计');
    });
    expect(screen.queryByText('私有')).toBeNull();
  });

  it('skill 目录不可用时 skill 行回落显示 slug（优雅降级，不留空白）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') {
        return Promise.resolve([
          makeBinding({ id: 'bind_s1', kind: 'skill', target: 'brainstorming', title: 'brainstorming', mode: 'always' }),
        ]);
      }
      return Promise.resolve({ removed: true });
    });
    vi.mocked(invokeSkillIPC).mockResolvedValue(undefined);

    render(<RoleBindingsSection roleId="牧之" />);

    await waitFor(() => {
      expect(screen.getByTitle('brainstorming').textContent).toBe('brainstorming');
    });
    expect(within(screen.getByTestId('role-binding-bind_s1')).queryByText('私有')).toBeNull();
  });
});
