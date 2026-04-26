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
    });

    expect(groups.map((group) => group.label)).toEqual([
      '基础偏好',
      '能力与连接',
      '记忆与隐私',
      '系统',
    ]);
    expect(groups[0].tabs.map((tab) => tab.id)).toEqual([
      'general',
      'conversation',
      'model',
      'appearance',
    ]);
    expect(groups[0].tabs[0].label).toBe('权限与安全');
    expect(groups[3].tabs.map((tab) => tab.id)).toEqual([
      'cache',
      'update',
      'about',
    ]);
    expect(groups[3].tabs[0].label).toBe('数据与存储');
  });
});
