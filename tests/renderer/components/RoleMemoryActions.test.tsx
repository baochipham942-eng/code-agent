// ============================================================================
// RoleMemoryActions - 角色记忆区的「导出全部 / 在 Finder 中显示」动作
// N-ROLE-MEMORY-EXPORT：① 有记忆时两个按钮都在 ② 0 条时导出禁用并给提示
// ③ web 模式（无文件系统）隐藏 Finder 按钮 ④ 导出成功 toast 报落盘路径
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformWeb = vi.hoisted(() => ({ web: false }));
// 只替 isWebMode，其余导出透传（platform 还被组件链上的其它模块引用）
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/utils/platform')>();
  return { ...actual, isWebMode: () => platformWeb.web };
});

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: invokeDomainMock },
}));

const toastShowMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/hooks/useToast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useToast')>();
  return { ...actual, toast: { ...actual.toast, show: toastShowMock } };
});

import { RoleMemoryActions } from '../../../src/renderer/components/features/expert/RoleMemoryActions';

beforeEach(() => {
  platformWeb.web = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoleMemoryActions', () => {
  it('renders both action buttons when the role has memories', () => {
    render(<RoleMemoryActions roleId="研究员" memoryCount={2} />);

    expect((screen.getByTestId('role-memory-export') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('role-memory-export').textContent).toContain('导出全部记忆');
    expect((screen.getByTestId('role-memory-reveal') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('role-memory-reveal').textContent).toContain('在 Finder 中显示');
    // 有记忆时不显示「无可导出」提示
    expect(screen.queryByTestId('role-memory-export-hint')).toBeNull();
  });

  it('disables Export with an empty hint when there are no memories', () => {
    render(<RoleMemoryActions roleId="研究员" memoryCount={0} />);

    expect((screen.getByTestId('role-memory-export') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('role-memory-export-hint').textContent).toContain('暂无记忆可导出');
    // Finder 定位与记忆条数无关，仍然可用
    expect((screen.getByTestId('role-memory-reveal') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides the Finder button in web mode', () => {
    platformWeb.web = true;
    render(<RoleMemoryActions roleId="研究员" memoryCount={1} />);

    expect((screen.getByTestId('role-memory-export') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('role-memory-reveal')).toBeNull();
  });

  it('exports via the roles domain and toasts the saved path', async () => {
    invokeDomainMock.mockResolvedValue({ filePath: '/Users/who/Downloads/研究员-memories-2026-10-15.md', count: 2 });
    render(<RoleMemoryActions roleId="研究员" memoryCount={2} />);

    fireEvent.click(screen.getByTestId('role-memory-export'));

    await waitFor(() => expect(toastShowMock).toHaveBeenCalled());
    const [toastType, toastMessage] = toastShowMock.mock.calls[0];
    expect(toastType).toBe('success');
    expect(toastMessage).toContain('研究员-memories-2026-10-15.md');
    expect(invokeDomainMock).toHaveBeenCalledWith('domain:roles', 'exportMemories', { roleId: '研究员' });
  });

  it('reveals the memory folder via the roles domain', async () => {
    invokeDomainMock.mockResolvedValue({ revealed: true });
    render(<RoleMemoryActions roleId="研究员" memoryCount={1} />);

    fireEvent.click(screen.getByTestId('role-memory-reveal'));

    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith('domain:roles', 'revealMemoryFolder', { roleId: '研究员' });
    });
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('shows an error toast when export fails', async () => {
    invokeDomainMock.mockRejectedValue(new Error('This role has no memories to export'));
    render(<RoleMemoryActions roleId="研究员" memoryCount={2} />);

    fireEvent.click(screen.getByTestId('role-memory-export'));

    await waitFor(() => expect(toastShowMock).toHaveBeenCalled());
    const [toastType, toastMessage] = toastShowMock.mock.calls[0];
    expect(toastType).toBe('error');
    expect(toastMessage).toContain('This role has no memories to export');
  });
});
