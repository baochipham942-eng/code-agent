// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

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
  invoke.mockImplementation(async (channel: string) => (
    channel === IPC_CHANNELS.PERMISSION_GET_MODE ? 'default' : true
  ));
  invokeDomain.mockImplementation(async (domain: string, action: string) => {
    expect(domain).toBe(IPC_DOMAINS.SETTINGS);
    if (action === 'get') return { permissions: {} };
    if (action === 'getBudgetStatus') {
      return { scopes: { unattended: { currentCost: 2.5 } } };
    }
    return undefined;
  });
  useAppStore.setState({ language: 'zh' });
  useAuthStore.setState({ user: { id: 'admin', email: 'admin@test.dev', isAdmin: true } });
});

afterEach(cleanup);

describe('预算上限 renderer 写路径', () => {
  it('保存时把前台与无人值守上限分别写入 ScopedBudgetConfig', async () => {
    render(<GeneralSettings />);

    const foreground = await screen.findByTestId('foreground-budget-input') as HTMLInputElement;
    const unattended = screen.getByTestId('unattended-budget-input') as HTMLInputElement;
    expect(foreground.value).toBe('10.00');
    expect(unattended.value).toBe('3.00');

    fireEvent.change(foreground, { target: { value: '12.50' } });
    fireEvent.change(unattended, { target: { value: '4.25' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'setBudgetConfig', {
        budget: {
          foreground: { enabled: true, maxBudget: 12.5, resetPeriodHours: 24 },
          unattended: { enabled: true, maxBudget: 4.25, resetPeriodHours: 24 },
        },
      });
    });
  });

  it('恢复默认只回填 10/3，未点击保存前不写 IPC', async () => {
    render(<GeneralSettings />);
    const foreground = await screen.findByTestId('foreground-budget-input') as HTMLInputElement;
    const unattended = screen.getByTestId('unattended-budget-input') as HTMLInputElement;
    fireEvent.change(foreground, { target: { value: '50' } });
    fireEvent.change(unattended, { target: { value: '20' } });
    invokeDomain.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));

    expect(foreground.value).toBe('10.00');
    expect(unattended.value).toBe('3.00');
    expect(invokeDomain).not.toHaveBeenCalledWith(
      IPC_DOMAINS.SETTINGS,
      'setBudgetConfig',
      expect.anything(),
    );
  });
});

