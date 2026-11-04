// @vitest-environment jsdom
// ============================================================================
// JevKeyConfig 判官区块（N-JEV-DEFAULT-ON-CONSENT ②④）—— 状态行 / 降级计数 / 总开关 /
// 待同意态 Allow 按钮：消费 diagnostics jevStatus，写入走 settings/set 的 jev 块。
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
  const routable = keySource === 'official' || keySource === 'openrouter' || keySource === 'neo_hosted';
  return {
    keyConfigured: routable,
    route: routable ? keySource : null,
    keySource,
    ...(keySource === 'neo_hosted'
      ? { hosted: { eligible: true, blockedUntil: null as number | null, blockReason: null as null } }
      : {}),
    features: {
      permissionClassifier: { flagOn: true, effective: false, degradedCount },
      injectionScan: { flagOn: true, effective: false, degradedCount: 0 },
      compaction: { flagOn: true, effective: false, degradedCount: 0 },
      router: { flagOn: true, effective: false, degradedCount: 0 },
    },
  };
}

/** 托管判官被限流的状态形状（blockedUntil 未到点）。 */
function hostedBlockedStatus(blockReason: 'user_daily_limit' | 'global_fuse'): JevStatus {
  return {
    ...statusOf('neo_hosted'),
    keyConfigured: false,
    route: null,
    hosted: { eligible: true, blockedUntil: Date.now() + 60 * 60 * 1000, blockReason },
  };
}

function stubIpc(
  jevSettings: { enabled?: boolean; openRouterConsent?: boolean; neoHostedEnabled?: boolean } | undefined,
  status: JevStatus | null,
) {
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

  it('点 Allow → settings/set 写 jev.openRouterConsent: true', async () => {
    stubIpc({ enabled: true, openRouterConsent: false }, statusOf('openrouter_pending_consent'));
    render(<JevKeyConfig />);
    fireEvent.click(await screen.findByTestId('jev-consent-allow'));
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        settings: { jev: { openRouterConsent: true } },
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
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('api.typesafe.ai');
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('OpenRouter');
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('命令文本');
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        settings: { jev: { enabled: true } },
      });
    });
  });

  it('已保存的 TypeSafe key 在打开设置时直接显示打码', async () => {
    stubIpc({ enabled: true }, statusOf('official'));
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'getAllServiceKeys') return { typesafe: 'ts-key12...' };
      if (action === 'get') return { jev: { enabled: true } };
      if (action === 'jevStatus') return statusOf('official');
      return undefined;
    });
    render(<JevKeyConfig />);
    expect((await screen.findByTestId('jev-key-masked')).textContent).toBe('ts-key12...');
    expect(screen.queryByTestId('jev-key-input')).toBeNull();
  });

  it('保存调用 setServiceApiKey，空保存已配置 key 要先确认才清除', async () => {
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'getAllServiceKeys') return { typesafe: 'ts-key12...' };
      if (action === 'get') return { jev: { enabled: true } };
      if (action === 'jevStatus') return statusOf('none');
      return undefined;
    });
    render(<JevKeyConfig />);
    expect(await screen.findByTestId('jev-key-masked')).toBeTruthy();
    fireEvent.click(screen.getByTestId('jev-key-change'));
    fireEvent.change(screen.getByTestId('jev-key-input'), { target: { value: 'ts-live-secret-value' } });
    fireEvent.click(screen.getByTestId('jev-key-save'));
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'typesafe', apiKey: 'ts-live-secret-value' },
      );
    });
    expect((await screen.findByTestId('jev-key-masked')).textContent).toBe('ts-live-...');

    fireEvent.click(screen.getByTestId('jev-key-change'));
    fireEvent.click(screen.getByTestId('jev-key-save'));
    expect(await screen.findByText('清除 TypeSafe API Key？')).toBeTruthy();
    fireEvent.click(screen.getByText('清除'));
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'typesafe', apiKey: '' },
      );
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

// ---------------------------------------------------------------------------
// Neo 云判官（N-JEV-NEO-KEY）：hosted 态状态行 / 子开关 / 披露 / 限流文案
// ---------------------------------------------------------------------------

describe('JevKeyConfig Neo 云判官区块', () => {
  function hostedToggle(container: HTMLElement): HTMLElement | null {
    return container.querySelectorAll('[role="switch"]')[1] as HTMLElement | null ?? null;
  }

  it('hosted 可用：状态行说明在用 Neo 云判官、子开关开、披露句说明经 Neo 服务器转发且不存储', async () => {
    stubIpc({ enabled: true, neoHostedEnabled: true }, statusOf('neo_hosted'));
    const { container } = render(<JevKeyConfig />);
    expect((await screen.findByTestId('jev-judge-status')).textContent).toContain('Neo 云判官');
    expect((await screen.findByTestId('jev-judge-status')).textContent).toContain('没有自己的 key');
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('经 Neo 的服务器转发');
    expect(screen.getByTestId('jev-disclosure').textContent).toContain('不存储请求内容');
    const row = screen.getByTestId('jev-hosted-row');
    expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(hostedToggle(container)).not.toBeNull();
  });

  it('额度用完：状态行显示今日额度已用完/明天重置/回退普通确认', async () => {
    stubIpc({ enabled: true }, hostedBlockedStatus('user_daily_limit'));
    render(<JevKeyConfig />);
    const status = await screen.findByTestId('jev-judge-status');
    expect(status.textContent).toContain('今日云判官额度已用完');
    expect(status.textContent).toContain('明天重置');
    expect(status.textContent).toContain('普通确认');
  });

  it('全局熔断：状态行显示云判官今日不可用/自动恢复', async () => {
    stubIpc({ enabled: true }, hostedBlockedStatus('global_fuse'));
    render(<JevKeyConfig />);
    const status = await screen.findByTestId('jev-judge-status');
    expect(status.textContent).toContain('云判官今日不可用');
    expect(status.textContent).toContain('自动恢复');
  });

  it('云判官子开关关：keySource 回 none，但子开关行保留且可重新打开', async () => {
    // 真实 getJevStatus 在「子开关关但有资格」时仍带 hosted={eligible:true}。
    stubIpc({ enabled: true, neoHostedEnabled: false }, {
      ...statusOf('none'),
      hosted: { eligible: true, blockedUntil: null, blockReason: null },
    });
    const { container } = render(<JevKeyConfig />);
    await screen.findByTestId('jev-judge-status');
    expect(screen.getByTestId('jev-judge-status').textContent).toContain('未启用');
    const toggle = hostedToggle(container);
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        settings: { jev: { neoHostedEnabled: true } },
      });
    });
  });

  it('未登录：无 hosted 切片 → 不出现云判官子开关行（与今日 none 行为一致）', async () => {
    stubIpc({ enabled: true }, statusOf('none'));
    const { container } = render(<JevKeyConfig />);
    await screen.findByTestId('jev-judge-status');
    expect(screen.queryByTestId('jev-hosted-row')).toBeNull();
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });
});
