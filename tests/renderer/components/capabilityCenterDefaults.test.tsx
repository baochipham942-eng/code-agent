// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { settingsCapabilityFocus: null; clearSettingsCapabilityFocus: () => void }) => unknown) => selector({
    settingsCapabilityFocus: null,
    clearSettingsCapabilityFocus: () => undefined,
  }),
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue({ success: true, data: [] }) },
}));

vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPC: vi.fn().mockResolvedValue([]),
}));

import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';
import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';

describe('capability center defaults', () => {
  afterEach(cleanup);

  it('技能页默认选中发现安装', async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '发现安装' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tab', { name: /已安装/ }).getAttribute('aria-selected')).toBe('false');
  });

  // 这条门原来只断言渲染结果不含 "Alma"，但 mock 把插件列表喂成空，
  // Alma 卡片根本没机会渲染 —— 是假绿。改成扫源码：只要这三个消费页
  // 还引用任何 Alma 符号就红，不依赖某次渲染恰好走到哪个分支。
  it('能力中心三个消费页不再引用任何 Alma 符号', () => {
    const tabsDir = path.resolve(__dirname, '../../../src/renderer/components/features/settings/tabs');
    for (const file of ['PluginsSettings.tsx', 'MCPSettings.tsx', 'McpDiscoverTab.tsx', 'SkillsDiscoverTab.tsx']) {
      const source = fs.readFileSync(path.join(tabsDir, file), 'utf8');
      expect(source, `${file} 仍引用 Alma`).not.toMatch(/Alma/i);
    }
    expect(fs.existsSync(path.join(tabsDir, 'AlmaRegistryAuditPanel.tsx'))).toBe(false);
  });

  it('插件管理页渲染结果不含 Alma', () => {
    expect(renderToStaticMarkup(<PluginsSettings />)).not.toContain('Alma');
  });
});
