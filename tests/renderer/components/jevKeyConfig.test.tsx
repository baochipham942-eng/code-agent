// @vitest-environment jsdom
// ============================================================================
// JevKeyConfig 判官区块（N-JEV-DEFAULT-ON-CONSENT ②④）—— 状态行 / 降级计数 / 总开关 /
// 待同意态 Allow 按钮：消费 diagnostics jevStatus，写入走 settings setJevSettings。
// ipcService 与 toast 全 mock，不触网。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JevKeyConfig } from '../../../src/renderer/components/features/settings/tabs/JevKeyConfig';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { JevStatus } from '../../../src/shared/contract';
import ipcService from '../../../src/renderer/services/ipcService';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: toasts,
}));

function statusOf(keySource: JevStatus['keySource'], degradedCount = 0): JevStatus {
  return {
    keyConfigured: keySource === 'official' || keySource === 'openrouter',
    route: keySource === 'official' || keySource === 'openrouter' ? keySource : null,
    keySource,
    features: {
      permissionClassifier: { flagOn: true, effective: false, degradedCount },
      injectionScan: { flagOn: true, effective: false, degradedCount: 0 },
      compaction: { flagOn: true, effective: false, degradedCount: 0 },
      router: { flagOn: true, effective: false, degradedCount: 0 },
    },
  };
}

function stubIpc(jevSettings: { enabled?: boolean; openRouterConsent?: boolean } | undefined, status: JevStatus | null) {
  vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
    if (action === 'getAllServiceKeys') return {};
    if (action === 'get') return { jev: jevSettings };
    if (action === 'jevStatus') return status;
    return undefined;
  });
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('JevKeyConfig 判官区块', () => {
  it('待同意态：状态行说明检测到 OpenRouter key 未允许，出现 Allow 按钮', async () => {
    stubIpc({ enabled: true, openRouterConsent: false }, statusOf('openrouter_pending_consent'));
    render(<JevKeyConfig />);
    const statusLine = await screen.findByTestId('jev-judge-status');
    expect(statusLine.textContent).toContain('检测到你的 OpenRouter key，尚未允许使用');
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('OpenRouter');
    expect(screen.getByTestId('jev-consent-allow')).toBeDefined();
  });

  it('点 Allow → setJevSettings 写 openRouterConsent: true', async () => {
    stubIpc({ enabled: true, openRouterConsent: false }, statusOf('openrouter_pending_consent'));
    render(<JevKeyConfig />);
    fireEvent.click(await screen.findByTestId('jev-consent-allow'));
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'setJevSettings', {
        openRouterConsent: true,
      });
    });
    expect(toasts.success).toHaveBeenCalled();
  });

  it('官方 key 态：状态行报官方 key，没有 Allow 按钮', async () => {
    stubIpc({ enabled: true }, statusOf('official'));
    render(<JevKeyConfig />);
    expect((await screen.findByTestId('jev-judge-status')).textContent).toContain('官方 TypeSafe key');
    expect(screen.queryByTestId('jev-consent-allow')).toBeNull();
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('api.typesafe.ai');
  });

  it('总开关关：Toggle 关、状态行「已关闭」、off 提示出现；点击可重新开', async () => {
    stubIpc({ enabled: false }, statusOf('disabled_by_user'));
    const { container } = render(<JevKeyConfig />);
    await screen.findByTestId('jev-judge-status');
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('jev-judge-status').textContent).toContain('已关闭');
    expect(screen.getByTestId('jev-off-hint').textContent).toContain('重启后仍保持关闭');
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'setJevSettings', {
        enabled: true,
      });
    });
  });

  it('降级计数 > 0 时显示本次运行跳过次数', async () => {
    stubIpc({ enabled: true }, statusOf('none', 3));
    render(<JevKeyConfig />);
    const degraded = await screen.findByTestId('jev-degraded-count');
    expect(degraded.textContent).toContain('3');
    expect(degraded.textContent).toContain('次判官调用');
  });
});
