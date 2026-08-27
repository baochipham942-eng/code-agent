// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { BudgetAlertEvent } from '../../../src/shared/ipc/handlers';

const listener = vi.hoisted(() => ({ current: null as ((event: BudgetAlertEvent) => void) | null }));
const openBudgetSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: {
    on: vi.fn((channel: string, callback: (event: BudgetAlertEvent) => void) => {
      expect(channel).toBe(IPC_CHANNELS.BUDGET_ALERT);
      listener.current = callback;
      return vi.fn();
    }),
  },
}));
vi.mock('../../../src/renderer/utils/budgetSettingsNavigation', () => ({ openBudgetSettings }));

import { BudgetAlertNotice } from '../../../src/renderer/components/BudgetAlertNotice';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  listener.current = null;
  openBudgetSettings.mockReset();
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('预算超限终态通知', () => {
  it('单条 blocked 信号写清 scope、花费、上限、恢复时间，并直达预算设置', () => {
    render(<BudgetAlertNotice />);
    expect(listener.current).not.toBeNull();

    act(() => {
      listener.current?.({
        scope: 'unattended',
        level: 'blocked',
        currentCost: 3,
        maxBudget: 3,
        usagePercentage: 1,
        resetTime: new Date('2026-08-28T00:00:00+08:00').getTime(),
      });
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toContain('无人值守预算已用尽');
    expect(toasts[0].message).toContain('$3.00 / $3.00');
    expect(toasts[0].message).toContain('下个周期');
    expect(toasts[0].message).toContain('自动恢复');
    expect(toasts[0].message).not.toContain('重置时间待同步');
    expect(toasts[0].action?.label).toBe('去调整上限 →');

    toasts[0].action?.onClick();
    expect(openBudgetSettings).toHaveBeenCalledOnce();
  });
});

