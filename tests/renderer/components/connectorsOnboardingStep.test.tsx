// @vitest-environment jsdom
// ConnectorsOnboardingStep —— 本机连接器行内授权（repairPermission）与 Feishu/Google 记意图
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { ConnectorStatusSummary } from '../../../src/shared/ipc';

const { mockInvokeDomain, mockLanguage } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  mockLanguage: { value: 'zh' as 'zh' | 'en' },
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhText } = await import('../../../src/renderer/i18n/zh');
  const { en: enText } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: mockLanguage.value === 'en' ? enText : zhText,
      language: mockLanguage.value,
    }),
  };
});

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mockInvokeDomain,
  },
}));

import { ConnectorsOnboardingStep } from '../../../src/renderer/components/onboarding/ConnectorsOnboardingStep';

function statusFor(id: string, overrides: Partial<ConnectorStatusSummary> = {}): ConnectorStatusSummary {
  return {
    id,
    label: id,
    connected: false,
    readiness: 'ready',
    capabilities: [],
    ...overrides,
  };
}

function renderStep() {
  const onConnectIntent = vi.fn();
  render(React.createElement(ConnectorsOnboardingStep, {
    pendingConnectorId: null,
    onConnectIntent,
  }));
  return { onConnectIntent };
}

describe('ConnectorsOnboardingStep', () => {
  beforeEach(() => {
    mockLanguage.value = 'zh';
    mockInvokeDomain.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('本机行点击调 connector 域 repairPermission 并行内展示已连接', async () => {
    mockInvokeDomain.mockResolvedValue([
      statusFor('mail', { readiness: 'ready', connected: true }),
    ]);
    renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent).toBe('已连接 ✓');
    });
    expect(mockInvokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.CONNECTOR,
      'repairPermission',
      { connectorId: 'mail' },
    );
    expect(screen.getByTestId('onboarding-connect-mail').textContent).toBe('已连接');
  });

  it('授权通过但没有账号：行内展示 no-account 文案', async () => {
    mockInvokeDomain.mockResolvedValue([
      statusFor('mail', {
        readiness: 'ready',
        connected: true,
        detail: 'Mail 权限修复检查通过，但没有找到可访问的邮件账户',
      }),
    ]);
    renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent)
        .toBe('已连接，但「邮件」里还没有账号，添加后再回来就能用。');
    });
  });

  it('授权被拒：行内展示拒绝文案并记住 id 供落页，不提供重试', async () => {
    mockInvokeDomain.mockResolvedValue([
      statusFor('mail', {
        readiness: 'failed',
        error: 'execution error: Not authorized to send Apple events to Mail. (-1743)',
      }),
    ]);
    const { onConnectIntent } = renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent)
        .toBe('刚才没获系统授权。可到 系统设置 › 隐私与安全性 › 自动化 里重新允许；完成引导后仍会为你打开「邮件」的连接卡。');
    });
    expect(onConnectIntent).toHaveBeenCalledWith('mail');
    // Don't Allow 后系统不会再弹：按钮进入终态禁用，不给原地重试，也不谎称已连接
    const deniedButton = screen.getByTestId('onboarding-connect-mail');
    expect(deniedButton.hasAttribute('disabled')).toBe(true);
    expect(deniedButton.textContent).toBe('去连接');
  });

  it('repairPermission 整体 reject 时补读 listStatuses 判失败', async () => {
    mockInvokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'repairPermission') return Promise.reject(new Error('osascript failed'));
      return Promise.resolve([
        statusFor('reminders', { readiness: 'failed', error: 'Not authorized (-1743)' }),
      ]);
    });
    const { onConnectIntent } = renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-reminders'));

    await waitFor(() => {
      expect(mockInvokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.CONNECTOR, 'listStatuses');
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-reminders').textContent)
        .toContain('刚才没获系统授权');
    });
    expect(onConnectIntent).toHaveBeenCalledWith('reminders');
  });

  it('补读也失败时按 failed 兜底', async () => {
    mockInvokeDomain.mockRejectedValue(new Error('ipc down'));
    const { onConnectIntent } = renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-calendar'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-calendar').textContent)
        .toContain('刚才没获系统授权');
    });
    expect(onConnectIntent).toHaveBeenCalledWith('calendar');
  });

  it('busy 期间展示连接中文案且本机行全禁用', async () => {
    let release!: (statuses: ConnectorStatusSummary[]) => void;
    const gate = new Promise<ConnectorStatusSummary[]>((resolve) => {
      release = resolve;
    });
    mockInvokeDomain.mockReturnValue(gate);
    renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));

    expect(screen.getByTestId('onboarding-connecting-mail').textContent).toBe('正在请求系统授权…');
    expect(screen.getByTestId('onboarding-connect-calendar').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('onboarding-connect-result-mail')).toBeNull();

    release([statusFor('mail', { readiness: 'ready', connected: true })]);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent).toBe('已连接 ✓');
    });
  });

  it('Feishu 行保持记意图：不触 IPC，展示既有 pending 提示', () => {
    const { onConnectIntent } = renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));

    expect(mockInvokeDomain).not.toHaveBeenCalled();
    expect(onConnectIntent).toHaveBeenCalledWith('feishu');
  });

  it('pending 提示按行名插值（Google 日历）', () => {
    render(React.createElement(ConnectorsOnboardingStep, {
      pendingConnectorId: 'google-calendar',
      onConnectIntent: vi.fn(),
    }));

    expect(screen.getByText('已记下，完成引导后会为你打开Google 日历的连接页。')).toBeTruthy();
  });

  it('en：ready 与拒绝文案用英文渲染', async () => {
    mockLanguage.value = 'en';
    mockInvokeDomain.mockResolvedValue([
      statusFor('mail', { readiness: 'ready', connected: true }),
    ]);
    renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent).toBe('Connected ✓');
    });
    cleanup();

    mockInvokeDomain.mockResolvedValue([
      statusFor('reminders', { readiness: 'failed', error: 'Not authorized (-1743)' }),
    ]);
    renderStep();
    fireEvent.click(screen.getByTestId('onboarding-connect-reminders'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-reminders').textContent)
        .toBe('Not allowed just now. Re-enable it under System Settings › Privacy & Security › Automation; the "Reminders" card will still open after you finish setup.');
    });
  });
});
