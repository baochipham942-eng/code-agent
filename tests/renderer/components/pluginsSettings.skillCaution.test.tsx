// @vitest-environment jsdom
// ============================================================================
// PluginsSettings 的 marketplace 安装 caution 确认流程测试
// 覆盖：MARKETPLACE_INSTALL_PLUGIN 返回 SKILL_CAUTION_CONFIRMATION_REQUIRED →
// 弹 confirm 模式；确认携 cautionConfirmationToken 重发（options 其余不变）→ 成功；
// 取消不重发。mock 风格对齐 pluginsSettings.installCancel.test.tsx（ipcService 桩）。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const cautionText = zh.settings.skills.caution;

const PLUGIN_ENTRY = {
  name: 'cautious-plugin',
  marketplace: 'official',
  source: './cautious-plugin',
  skills: ['skills/x'],
};
const SPEC = 'cautious-plugin@official';

function confirmationRequired(overrides: { confirmationToken?: string } = {}) {
  return {
    success: false as const,
    code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED' as const,
    pluginSpec: SPEC,
    sourceTrust: 'unsigned-github-archive' as const,
    cautionHits: [
      { file: 'skills/x/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' },
    ],
    confirmationToken: overrides.confirmationToken ?? 'token-1',
  };
}

/** 点插件卡上的安装钮（卡片状态角上有 data-testid，从那里圈按钮） */
async function clickInstall() {
  const state = await screen.findByTestId(`plugin-install-state-${SPEC}`);
  const button = state.querySelector('button');
  expect(button).toBeTruthy();
  fireEvent.click(button!);
}

function installCalls() {
  return invoke.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN);
}

describe('PluginsSettings marketplace 安装 caution 确认', () => {
  beforeEach(() => {
    invoke.mockReset();
    // marketplace 目录区按管理员门控；internalFeatureStore 还会走 useAuthStore.getState()
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ user: null });
  });

  it('confirmation-required → 确认携 token 重发（scope 不变）→ 成功提示并刷新', async () => {
    const installResults = [
      confirmationRequired(),
      { success: true, plugin: { name: 'cautious-plugin', marketplace: 'official' } },
    ];
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS) {
        return Promise.resolve({ success: true, data: [PLUGIN_ENTRY] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN) {
        return Promise.resolve(installResults.shift());
      }
      throw new Error(`Unexpected channel ${channel}`);
    });
    render(<PluginsSettings />);
    await clickInstall();

    // 确认面：未签名来源标签 + 命中（插件卡与弹窗头部同名并存）
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    expect(screen.getAllByText(SPEC)).toHaveLength(2);
    expect(screen.getByText(cautionText.sourceLabels['unsigned-github-archive'])).toBeTruthy();
    expect(screen.getByText(cautionText.rules.git_clean)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    await waitFor(() => {
      expect(installCalls()).toEqual([
        [IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, SPEC, { scope: 'user' }],
        [
          IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN,
          SPEC,
          { scope: 'user', cautionConfirmationToken: 'token-1' },
        ],
      ]);
    }, { timeout: 5000 });
    // 成功收尾与正常安装路径同构：弹窗关闭、列表刷新（reload 起手会清 notice，
    // 成功提示本就不驻留——与 handleInstall 原行为一致）、无错误 alert
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
    const reloadCalls = invoke.mock.calls.filter(
      ([channel]) => channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS,
    );
    expect(reloadCalls.length).toBeGreaterThan(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('取消 → 不发第二次安装 IPC', async () => {
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS) {
        return Promise.resolve({ success: true, data: [PLUGIN_ENTRY] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN) {
        return Promise.resolve(confirmationRequired());
      }
      throw new Error(`Unexpected channel ${channel}`);
    });
    render(<PluginsSettings />);
    await clickInstall();

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));

    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
    expect(installCalls()).toEqual([
      [IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, SPEC, { scope: 'user' }],
    ]);
  });
});
