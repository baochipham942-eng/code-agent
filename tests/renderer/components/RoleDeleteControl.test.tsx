// ============================================================================
// RoleDeleteControl - 用户自建角色删除入口（N-ROLE-CREATE-DIRECT-DELETE ⑤）
// 确认前零 IPC；确认才调 deleteRole；toast 的「撤销」调 restoreDeletedRole；
// 内置 / 装包 / 孤儿角色不显示入口（shouldMountRoleDeleteControl）
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: invokeDomainMock },
}));

import { RoleDeleteControl, shouldMountRoleDeleteControl } from '../../../src/renderer/components/features/expert/RoleDeleteControl';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function renderControl(overrides: Partial<Parameters<typeof RoleDeleteControl>[0]> = {}) {
  const onDeleted = vi.fn();
  const onRestored = vi.fn();
  const utils = render(
    <RoleDeleteControl roleId="日历助理" displayName="日历助理" onDeleted={onDeleted} onRestored={onRestored} {...overrides} />,
  );
  return { onDeleted, onRestored, ...utils };
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoleDeleteControl（⑤）', () => {
  it('确认前不发任何 IPC：点开弹窗、取消，invokeDomain 一次都不被调', async () => {
    renderControl();
    expect(invokeDomainMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('role-delete'));
    // 弹窗打开（确认按钮可见），但还没有 IPC
    expect(screen.getByText('删除这位专家？')).toBeTruthy();
    expect(invokeDomainMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('取消'));
    expect(invokeDomainMock).not.toHaveBeenCalled();
    expect(screen.queryByText('删除这位专家？')).toBeNull();
  });

  it('确认后才调 deleteRole，成功后回调 onDeleted 并弹出带「撤销」的 toast', async () => {
    invokeDomainMock.mockResolvedValue({ trashId: 'trash-abc' });
    const { onDeleted } = renderControl();

    fireEvent.click(screen.getByTestId('role-delete'));
    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith('domain:roles', 'deleteRole', { roleId: '日历助理' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toContain('日历助理');
    expect(toasts[0].action?.label).toBe('撤销');
  });

  it('「撤销」动作调 restoreDeletedRole(trashId) 并回调 onRestored', async () => {
    invokeDomainMock.mockResolvedValue({ trashId: 'trash-xyz' });
    const { onRestored } = renderControl();

    fireEvent.click(screen.getByTestId('role-delete'));
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));

    invokeDomainMock.mockClear();
    await act(async () => {
      useToastStore.getState().toasts[0].action!.onClick();
    });

    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith('domain:roles', 'restoreDeletedRole', { trashId: 'trash-xyz' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    // 撤销成功后重新打开详情页（删除时 onDeleted 已离开详情，loadDetail 是死回调；
    // 真跑 2026-11-04 实证：不重开详情，已挂载的专家列表不会自动刷出还原的角色）
    await waitFor(() => expect(useAppStore.getState().expertDetailRoleId).toBe('日历助理'));
    // 撤销成功后有恢复成功的 toast
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((toast) => toast.type === 'success' && toast.message.includes('恢复'))).toBe(true);
  });

  it('删除失败弹 error toast，不走撤销', async () => {
    invokeDomainMock.mockRejectedValue(new Error('Built-in roles cannot be deleted'));
    const { onDeleted } = renderControl();

    fireEvent.click(screen.getByTestId('role-delete'));
    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    expect(useToastStore.getState().toasts[0].type).toBe('error');
    expect(useToastStore.getState().toasts[0].action).toBeUndefined();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('内置 / 装包 / 孤儿角色不挂载删除入口', () => {
    // 内置（含退役预设）：isBuiltin
    expect(shouldMountRoleDeleteControl({ isBuiltin: true, definition: '---', restore: undefined })).toBe(false);
    // 装了角色包：detail.restore 有值
    expect(shouldMountRoleDeleteControl({ isBuiltin: false, definition: '---', restore: { available: true } })).toBe(false);
    // 孤儿：没有定义文件
    expect(shouldMountRoleDeleteControl({ isBuiltin: false, definition: null, restore: undefined })).toBe(false);
    // 用户自建：唯一可挂载的组合
    expect(shouldMountRoleDeleteControl({ isBuiltin: false, definition: '---', restore: undefined })).toBe(true);
  });
});

// fireEvent 之后的异步闭包（toast action 里的 async IIFE）要包 act，避免 state 更新警告
async function act(fn: () => Promise<void>) {
  const { act: rtlAct } = await import('@testing-library/react');
  await rtlAct(fn);
}
