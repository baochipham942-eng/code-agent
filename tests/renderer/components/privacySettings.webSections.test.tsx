// @vitest-environment jsdom
// FB-240 / N-PRIVACY-WEB-SECTIONS 验收①②：web 模式（isWebMode=true）下隐私设置页
// 只短路桌面专属段（PII 脚本三段 + 第三方插件界面开关），其余段照常渲染——
// SETTINGS 通道在 web 链路是通的，遥测开关在 web 上真的能读写。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());
const isWebMode = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

const CHANNEL_TOGGLES = [
  'privacy-posthog-toggle',
  'privacy-cloud-upload-toggle',
  'privacy-langfuse-toggle',
  'privacy-crash-reporting-toggle',
] as const;

const POST_LAUNCH_SWITCHES = [
  'postlaunch-scoring-switch',
  'postlaunch-reflow-switch',
] as const;

// web 模式下只该有 SETTINGS 域的调用：PII 域（spawn 本地脚本）进来就抛，锚定「web 缺口
// 与 IPC 故障无关，PII 链路在 web 上根本不该被碰」。
function mockIpc(settings: Record<string, unknown>, options?: { setFails?: boolean }): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(settings);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'set') {
      return options?.setFails ? Promise.reject(new Error('settings write failed')) : Promise.resolve(undefined);
    }
    throw new Error(`Unexpected call ${domain}:${action}`);
  });
}

afterEach(() => {
  cleanup();
  isWebMode.mockReturnValue(true);
});

describe('PrivacySettings web 模式渲染（FB-240）', () => {
  it('web 下渲染边界/语音/凭证/遥测/反馈钩子段与七个控件，PII 三段与第三方插件开关缺席，WebModeBanner 仍在', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    // 非桌面专属段全部在场（SettingsSection 的标题是 h4）
    for (const title of [
      zh.settings.privacy.boundary.title,
      zh.settings.privacy.voice.title,
      zh.settings.privacy.auth.title,
      zh.settings.privacy.telemetry.title,
      zh.settings.privacy.evaluation.title,
    ]) {
      expect(screen.getByRole('heading', { level: 4, name: title })).toBeTruthy();
    }

    // 七个控件：四个遥测通道开关 + 两个 post-launch 开关 + 评测反馈池钩子命令
    for (const testId of [...CHANNEL_TOGGLES, ...POST_LAUNCH_SWITCHES, 'eval-feedback-hook-command']) {
      expect(await screen.findByTestId(testId)).toBeTruthy();
    }

    // 桌面专属段缺席：PII 脚本三段（状态/操作/日志）+ 第三方插件界面开关
    for (const title of [
      zh.settings.privacy.status.title,
      zh.settings.privacy.actions.title,
      zh.settings.privacy.logs.title,
      zh.settings.privacy.pluginUi.title,
    ]) {
      expect(screen.queryByRole('heading', { level: 4, name: title })).toBeNull();
    }

    // 降级横幅仍在最顶部
    expect(screen.getByText(zh.settings.webModeBanner.desktopOnlyFeature)).toBeTruthy();
  });

  it('web 下点击遥测通道开关 → SETTINGS set 写 privacy.<channel>Enabled（验收②成功路）', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    const posthog = await screen.findByTestId('privacy-posthog-toggle');
    await waitFor(() => expect((posthog as HTMLInputElement).checked).toBe(true));
    fireEvent.click(posthog);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { privacy: { posthogEnabled: false } },
      );
    });
  });

  it('web 下 SETTINGS set 写失败 → 开关回滚到原值（验收②失败路，沿用 handleChannelToggle）', async () => {
    mockIpc({}, { setFails: true });
    render(<PrivacySettings />);

    const crash = await screen.findByTestId('privacy-crash-reporting-toggle');
    await waitFor(() => expect((crash as HTMLInputElement).checked).toBe(true));
    fireEvent.click(crash);
    // 乐观更新先翻面
    expect((crash as HTMLInputElement).checked).toBe(false);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { privacy: { crashReportingEnabled: false } },
      );
    });
    // 写失败后弹回原值
    await waitFor(() => expect((crash as HTMLInputElement).checked).toBe(true));
  });
});
