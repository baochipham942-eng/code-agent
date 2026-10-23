// @vitest-environment jsdom
// ============================================================================
// 「从其他 AI 应用导入」导航显隐测试（N-EXTHISTORY-IMPORT-K1A，验收①）：
// 设置侧栏入口只在检测到来源（showExternalImportTab）时出现，且落在「记忆与隐私」组；
// 记忆页入口块同样只在检测可用时渲染，点击深链 external-import。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));

vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

import { buildSettingsTabGroups } from '../../../src/renderer/components/features/settings/SettingsModal';
import { ExternalImportLinkSection } from '../../../src/renderer/components/features/settings/tabs/MemoryTab';
import { useExternalImportStore } from '../../../src/renderer/stores/externalImportStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useExternalImportStore.setState({ status: 'idle', result: null, error: null });
});

afterEach(cleanup);

describe('settings 侧栏入口显隐（验收①）', () => {
  it('检测到来源 → external-import 出现在「记忆与隐私」组', () => {
    const groups = buildSettingsTabGroups({
      t: zh,
      showScreenMemoryTab: true,
      showUpdateTab: false,
      hasOptionalUpdate: false,
      showExternalImportTab: true,
    });
    const memoryGroup = groups.find((group) => group.id === 'memory');
    expect(memoryGroup?.tabs.map((tab) => tab.id)).toContain('external-import');
    expect(memoryGroup?.tabs.find((tab) => tab.id === 'external-import')?.label)
      .toBe('从其他 AI 应用导入');
  });

  it('未检测到来源 → 无 external-import 入口', () => {
    const groups = buildSettingsTabGroups({
      t: zh,
      showScreenMemoryTab: true,
      showUpdateTab: false,
      hasOptionalUpdate: false,
      showExternalImportTab: false,
    });
    expect(groups.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain('external-import');
  });
});

describe('记忆页入口块（验收①）', () => {
  it('检测可用时渲染链接，点击走 openSettingsTab 深链', () => {
    useExternalImportStore.setState({
      status: 'available',
      result: {
        homeDir: '/tmp/h',
        anyDetected: true,
        sources: [],
        claudeLegacySkills: { enabled: true, count: 0 },
      },
      error: null,
    });
    const originalOpen = useAppStore.getState().openSettingsTab;
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab } as never);

    render(<ExternalImportLinkSection />);
    fireEvent.click(screen.getByText('打开导入页'));

    expect(openSettingsTab).toHaveBeenCalledWith('external-import');
    useAppStore.setState({ openSettingsTab: originalOpen } as never);
  });

  it('检测不可用（idle/检测中/无来源）时不渲染入口块', () => {
    for (const status of ['idle', 'checking', 'unavailable'] as const) {
      useExternalImportStore.setState({ status, result: null, error: null });
      const { container } = render(<ExternalImportLinkSection />);
      expect(container.querySelector('button')).toBeNull();
      cleanup();
    }
  });
});
