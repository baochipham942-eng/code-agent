import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));

vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

import {
  buildSettingsTabGroups,
  buildSettingsTabs,
  resolveOptionalUpdateInfo,
} from '../../../src/renderer/components/features/settings/SettingsModal';

// 导航标签走 i18n 单一真源后，直接用真实 zh 翻译对象（含 tabs/tabGroups/engineCompat 全量键）
import { zh } from '../../../src/renderer/i18n/zh';

const t = zh;

describe('SettingsModal screen memory tab visibility', () => {
  it('shows screen memory for desktop shells without requiring Electron update support', () => {
    const tabs = buildSettingsTabs({
      t,
      showScreenMemoryTab: true,
      showUpdateTab: false,
      hasOptionalUpdate: false,
    });

    const ids = tabs.map((tab) => tab.id);
    expect(ids).toContain('openchronicle');
    expect(ids).not.toContain('update');
  });

  it('keeps screen memory hidden when the shell is not desktop-capable', () => {
    const tabs = buildSettingsTabs({
      t,
      showScreenMemoryTab: false,
      showUpdateTab: false,
      hasOptionalUpdate: false,
    });

    expect(tabs.map((tab) => tab.id)).not.toContain('openchronicle');
  });

  it('groups settings tabs by product intent', () => {
    const groups = buildSettingsTabGroups({
      t,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: true,
      access: { isAdmin: true },
    });

    // Settings IA v2（2026-07-03 拍板）：默认 5 组 + 高级折叠组 + admin 管理组
    expect(groups.map((group) => group.label)).toEqual([
      '模型与能力',
      '基础偏好',
      '工作与协作',
      '记忆与隐私',
      '系统',
      '高级',
      '用户管理',
    ]);
    expect(groups[0].tabs.map((tab) => tab.id)).toEqual([
      'model',
      'visualModels',
      'search',
      'soul',
      'skills',
    ]);
    expect(groups[0].tabs[0].label).toBe('通用模型');
    expect(groups[1].tabs.map((tab) => tab.id)).toEqual([
      'appearance',
      'general',
      'conversation',
      'keybindings',
      'voiceInput',
    ]);
    expect(groups[2].tabs.map((tab) => tab.id)).toEqual([
      'workspace',
      'automation',
      'channels',
      'roles',
    ]);
    // 高级组：技术项收纳（普通用户可自行配置，默认折叠）
    expect(groups[5].tabs.map((tab) => tab.id)).toEqual([
      'agentEngine',
      'mcp',
      'plugins',
      'hooks',
      'appshots',
      'cache',
    ]);
    // 管理组仅 admin
    expect(groups[6].tabs.map((tab) => tab.id)).toEqual([
      'users',
      'invites',
      'controlPlane',
      'capabilities',
    ]);
    expect(groups[4].tabs.map((tab) => tab.id)).toEqual([
      'update',
      'about',
    ]);
  });

  it('hides user management tabs for non-admin users', () => {
    const groups = buildSettingsTabGroups({
      t,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: false,
      access: { isAdmin: false },
    });

    expect(groups.map((group) => group.label)).not.toContain('用户管理');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('users');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('invites');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('controlPlane');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('capabilities');
    // v2 拍板：plugins/hooks 下放普通用户（高级组内可自行配置）
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).toContain('plugins');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).toContain('hooks');
  });

  it('keeps personal settings tabs visible for non-admin users', () => {
    const groups = buildSettingsTabGroups({
      t,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: false,
      access: { isAdmin: false },
    });

    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual(expect.arrayContaining([
      'model',
      'mcp',
      'skills',
      'channels',
      'memory',
      'automation',
      'workspace',
    ]));
  });
});

describe('resolveOptionalUpdateInfo', () => {
  it('returns only non-force optional updates', async () => {
    await expect(resolveOptionalUpdateInfo(async () => ({
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    }))).resolves.toMatchObject({
      hasUpdate: true,
      latestVersion: '1.1.0',
    });

    await expect(resolveOptionalUpdateInfo(async () => ({
      hasUpdate: true,
      forceUpdate: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
    }))).resolves.toBeNull();

    await expect(resolveOptionalUpdateInfo(async () => ({
      hasUpdate: false,
      currentVersion: '1.0.0',
    }))).resolves.toBeNull();
  });

  it('swallows badge check failures so SettingsModal does not log an error', async () => {
    const onCheckFailed = vi.fn();

    await expect(resolveOptionalUpdateInfo(async () => {
      throw new Error('network unavailable');
    }, onCheckFailed)).resolves.toBeNull();

    expect(onCheckFailed).toHaveBeenCalledOnce();
  });
});
