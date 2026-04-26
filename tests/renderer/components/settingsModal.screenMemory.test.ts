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

import { buildSettingsTabs } from '../../../src/renderer/components/features/settings/SettingsModal';

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
});
