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

const t = {
  settings: {
    tabs: {
      general: '通用',
      model: '模型',
      appearance: '外观',
      data: '数据',
      update: '更新',
      about: '关于',
      memory: '记忆',
    },
  },
} as any;

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

    expect(groups.map((group) => group.label)).toEqual([
      '基础偏好',
      '能力与连接',
      '工作区与自动化',
      '用户管理',
      '记忆与隐私',
      '系统',
    ]);
    expect(groups[0].tabs.map((tab) => tab.id)).toEqual([
      'general',
      'conversation',
      'model',
      'agentEngine',
      'appearance',
      'soul',
    ]);
    expect(groups[0].tabs[0].label).toBe('权限与安全');
    expect(groups[3].tabs.map((tab) => tab.id)).toEqual([
      'users',
      'invites',
      'controlPlane',
    ]);
    expect(groups[3].tabs.map((tab) => tab.label)).toEqual([
      '用户管理',
      '邀请码管理',
      '控制平面',
    ]);
    expect(groups[1].tabs.map((tab) => tab.id)).toEqual([
      'capabilities',
      'plugins',
      'mcp',
      'skills',
      'channels',
      'hooks',
    ]);
    expect(groups[5].tabs.map((tab) => tab.id)).toEqual([
      'cache',
      'update',
      'about',
    ]);
    expect(groups[5].tabs[0].label).toBe('数据与存储');
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
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('plugins');
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('hooks');
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
