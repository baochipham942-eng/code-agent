// @vitest-environment jsdom
// N-SETTINGS-PERM-403-TOAST：非管理员打开「权限与安全」页不该调 get-mode
// （host 侧 assertAdminAccess 必 403，web 传输层又会把失败吞成 undefined 静默
// 显示默认档）——应直接读 SET_MODE 持久化进 settings 的档位。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain },
}));

import { GeneralSettings } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

beforeEach(() => {
  invoke.mockReset();
  invokeDomain.mockReset();
  invokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'get') return { permissions: { permissionMode: 'acceptEdits' } };
    if (action === 'getBudgetStatus') return {};
    return undefined;
  });
  useAppStore.setState({ language: 'zh' });
  useAuthStore.setState({ user: { id: 'test-user', email: 'user@test.dev', isAdmin: false } });
});

afterEach(cleanup);

describe('GeneralSettings non-admin permission mode (N-SETTINGS-PERM-403-TOAST)', () => {
  it('skips PERMISSION_GET_MODE and shows the persisted mode as current', async () => {
    render(<GeneralSettings />);

    const matches = await screen.findAllByText('替我审批');
    const row = matches.map((el) => el.closest('tr')).find((tr) => tr !== null);
    await waitFor(() => {
      expect(row?.textContent).toContain('当前模式');
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
