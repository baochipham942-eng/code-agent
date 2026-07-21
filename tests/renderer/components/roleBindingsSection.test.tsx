// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpertContextBinding } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([
    { id: 'lib_1', projectId: null, title: '产品语境卡', kind: 'upload', pathOrUri: '/x', tags: [], createdAt: 1, updatedAt: 1 },
  ]),
}));

import { RoleBindingsSection } from '../../../src/renderer/components/features/settings/tabs/RoleBindingsSection';

function makeBinding(overrides: Partial<ExpertContextBinding> = {}): ExpertContextBinding {
  return {
    id: 'bind_1',
    kind: 'file',
    target: '/Users/x/PRD 模板.md',
    title: 'PRD 模板.md',
    mode: 'on_demand',
    scope: 'private',
    createdAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it('渲染绑定条目（标题 + 模式/范围标签）并可移除', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') return Promise.resolve([makeBinding()]);
      return Promise.resolve({ removed: true });
    });
    render(<RoleBindingsSection roleId="牧之" />);
    await waitFor(() => {
      expect(screen.getByText('PRD 模板.md')).toBeTruthy();
    });
    expect(screen.getAllByText('按需').length).toBeGreaterThan(0);
    expect(screen.getAllByText('私有').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTitle('移除'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'removeBinding', { roleId: '牧之', bindingId: 'bind_1' });
    });
  });

  it('从资料库绑定走 addBinding（带当前 mode/scope）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBindings') return Promise.resolve([]);
      return Promise.resolve(makeBinding({ kind: 'library_item', target: 'lib_1' }));
    });
    render(<RoleBindingsSection roleId="牧之" />);
    await waitFor(() => {
      expect(screen.getByTestId('role-binding-library-select')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('role-binding-library-select'), { target: { value: 'lib_1' } });
    fireEvent.change(screen.getByTestId('role-binding-scope'), { target: { value: 'project' } });
    fireEvent.click(screen.getByTestId('role-binding-add-library'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'addBinding', {
        roleId: '牧之',
        kind: 'library_item',
        target: 'lib_1',
        mode: 'always',
        scope: 'project',
      });
    });
  });
});
