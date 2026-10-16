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

// jsdom 的 navigator.platform 是 ''（非 mac）——本机连接器行按平台门控（返工 r2），
// 默认桩成 macOS 让既有用例维持原行为；Windows 用例单独改写。
const originalPlatform = navigator.platform;
function stubNavigatorPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, value });
}

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
    stubNavigatorPlatform('MacIntel');
    mockLanguage.value = 'zh';
    mockInvokeDomain.mockReset();
  });

  afterEach(() => {
    stubNavigatorPlatform(originalPlatform);
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

  it('授权通过但没有账号：行内展示 no-account 文案（真实 listStatuses 形状，只认结构化信号）', async () => {
    // 生产路径 repairPermission 的回执是 handleListStatuses() → getStatus()：ready 分支
    // 的 detail 是固定文案，「没有找到可访问…」只出现在被 host 丢弃的 execute summary 里；
    // 空列表信号必须走 noAccessibleItems，渲染层不得匹配 detail 文案
    mockInvokeDomain.mockResolvedValue([
      statusFor('mail', {
        readiness: 'ready',
        connected: true,
        detail: 'Mail connector 已通过本地授权/可用性检查。',
        noAccessibleItems: true,
      }),
    ]);
    renderStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent)
        .toBe('已连接，但「邮件」里还没有账号，添加后再回来就能用。');
    });
  });

  it('detail 带旧标记文案但没有结构化信号时仍按已连接渲染', async () => {
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
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent).toBe('已连接 ✓');
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

  // 返工 r2：host 非 darwin 时 mail/calendar/reminders 一律 unavailable——这些行在
  // 非 macOS 上渲染只会换来 macOS 专属授权指引 + 永久禁用的死按钮 + 落到不存在
  // native 卡的深链。整行不渲染，SaaS 行不受影响。
  it('非 macOS：本机连接器行整行不渲染，SaaS 行照常记意图', () => {
    stubNavigatorPlatform('Win32');
    const { onConnectIntent } = renderStep();

    for (const id of ['mail', 'calendar', 'reminders']) {
      expect(document.querySelector(`[data-onboarding-connector="${id}"]`)).toBeNull();
      expect(screen.queryByTestId(`onboarding-connect-${id}`)).toBeNull();
      expect(screen.queryByTestId(`onboarding-connect-result-${id}`)).toBeNull();
    }
    expect(screen.queryByText(/系统设置 › 隐私与安全性/)).toBeNull();

    expect(document.querySelector('[data-onboarding-connector="feishu"]')).toBeTruthy();
    expect(document.querySelector('[data-onboarding-connector="google-calendar"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    expect(mockInvokeDomain).not.toHaveBeenCalled();
    expect(onConnectIntent).toHaveBeenCalledWith('feishu');
  });
});
