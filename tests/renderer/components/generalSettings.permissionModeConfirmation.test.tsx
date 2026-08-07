// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain },
}));

import { GeneralSettings } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

beforeEach(() => {
  invoke.mockReset();
  invokeDomain.mockReset();
  invoke.mockImplementation(async (channel: string) =>
    channel === IPC_CHANNELS.PERMISSION_GET_MODE ? 'default' : true,
  );
  invokeDomain.mockResolvedValue({ permissions: {} });
  useAppStore.setState({ language: 'zh' });
  // 切换按钮现在按 isAdmin 门禁（host 侧 assertAdminAccess 早已要求 admin，
  // 这里只是把渲染态对齐真实登录用户，避免测试假设一个从不存在的"未登录也能切"状态）。
  useAuthStore.setState({ user: { id: 'test-admin', email: 'admin@test.dev', isAdmin: true } });
});

afterEach(cleanup);

function switchButtonFor(modeName: string): HTMLButtonElement {
  const row = screen.getByText(modeName).closest('tr');
  const button = row?.querySelector('button');
  if (!button) throw new Error(`Missing switch button for ${modeName}`);
  return button;
}

describe('GeneralSettings permission mode confirmation', () => {
  it('sets the high-risk bypassPermissions mode only after explicit confirmation', async () => {
    render(<GeneralSettings />);
    await screen.findByText('完全访问权限');
    invoke.mockClear();

    fireEvent.click(switchButtonFor('完全访问权限'));

    expect(screen.getByRole('dialog').textContent).toContain(
      '权限检查已跳过。Agent 可以直接执行文件写入、命令执行等操作，请只在可信隔离环境中使用。',
    );
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(switchButtonFor('完全访问权限'));
    fireEvent.click(screen.getByRole('button', { name: '开启完全访问权限' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.PERMISSION_SET_MODE,
        'bypassPermissions',
      );
    });
  });

  it('keeps low- and medium-risk mode switches immediate', async () => {
    render(<GeneralSettings />);
    await screen.findByText('只读');
    invoke.mockClear();

    fireEvent.click(switchButtonFor('只读'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PERMISSION_SET_MODE, 'readOnly');
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(switchButtonFor('替我审批'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PERMISSION_SET_MODE, 'acceptEdits');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an error toast when the host rejects the switch without throwing (previously silent)', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.PERMISSION_GET_MODE) return 'default';
      if (channel === IPC_CHANNELS.PERMISSION_SET_MODE) return false;
      return true;
    });
    render(<GeneralSettings />);
    await screen.findByText('只读');

    fireEvent.click(switchButtonFor('只读'));

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true);
    });
  });

  it('disables the switch action for non-admin users, with an explanatory hint', async () => {
    useAuthStore.setState({ user: { id: 'test-nonadmin', email: 'user@test.dev', isAdmin: false } });
    render(<GeneralSettings />);
    await screen.findByText('只读');

    const button = switchButtonFor('只读');
    expect(button.disabled).toBe(true);
    expect(screen.getByText('切换权限模式需要管理员权限，当前账号无法操作。')).toBeTruthy();

    fireEvent.click(button);
    expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.PERMISSION_SET_MODE, 'readOnly');
  });
});
