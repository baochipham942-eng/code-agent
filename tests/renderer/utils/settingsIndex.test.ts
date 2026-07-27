import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { SETTINGS_INDEX, searchSettings } from '../../../src/renderer/utils/settingsIndex';
import { SETTINGS_TAB_IDS } from '../../../src/renderer/utils/settingsTabs';

const zhSearchIndex = zh.settings.searchIndex as Record<string, string>;
const enSearchIndex = en.settings.searchIndex as Record<string, string>;

describe('settings search index', () => {
  it('binds every entry labelKey to zh/en i18n search labels', () => {
    expect(Object.keys(zh.settings.searchIndex)).toHaveLength(SETTINGS_INDEX.length);
    expect(Object.keys(en.settings.searchIndex)).toHaveLength(SETTINGS_INDEX.length);

    for (const entry of SETTINGS_INDEX) {
      expect(zhSearchIndex[entry.labelKey]).toBeTruthy();
      expect(enSearchIndex[entry.labelKey]).toBeTruthy();
    }
  });

  it('covers conversation settings', () => {
    expect(searchSettings(zh.settings.searchIndex.modelRoutingStrategy).map((entry) => entry.tab)).toContain('conversation');
    expect(searchSettings(en.settings.searchIndex.modelRoutingStrategy).map((entry) => entry.tab)).toContain('conversation');
  });

  it('routes browser settings to workspace settings', () => {
    expect(searchSettings(zh.settings.searchIndex.browserToolMode).map((entry) => entry.tab)).toContain('workspace');
    expect(searchSettings(en.settings.searchIndex.browserToolMode).map((entry) => entry.tab)).toContain('workspace');
  });

  it('routes prompt management searches to persona settings', () => {
    expect(searchSettings(zh.settings.searchIndex.promptManager).map((entry) => entry.tab)).toContain('soul');
    expect(searchSettings(en.settings.searchIndex.promptManager).map((entry) => entry.tab)).toContain('soul');
  });

  it('covers plugin management settings for admins', () => {
    expect(searchSettings(zh.settings.searchIndex.pluginMarketplace, { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
    expect(searchSettings(zh.settings.searchIndex.pluginVisibility, { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
  });

  it('routes config scope searches to workspace settings', () => {
    expect(searchSettings('config scope').map((entry) => entry.tab)).toContain('workspace');
    expect(searchSettings(zh.settings.searchIndex.configScope).map((entry) => entry.tab)).toContain('workspace');
  });

  it('管理组迁 admin-console 后不再被搜索索引覆盖（2026-07 方案 9C）', () => {
    expect(searchSettings('user management', { isAdmin: true })).toHaveLength(0);
    expect(searchSettings('invite', { isAdmin: true })).toHaveLength(0);
    expect(searchSettings('control plane', { isAdmin: true })).toHaveLength(0);
    expect(searchSettings('capability center', { isAdmin: true })).toHaveLength(0);
  });

  it('keeps plugins/hooks searchable for non-admin users (Settings IA v2, 2026-07-03 拍板)', () => {
    expect(searchSettings(zh.settings.searchIndex.pluginMarketplace).map((entry) => entry.tab)).toContain('plugins');
    expect(searchSettings(zh.settings.searchIndex.hookConfig).map((entry) => entry.tab)).toContain('hooks');
  });

  it('keeps personal settings searchable for non-admin users', () => {
    expect(searchSettings(zh.settings.tabs.model).map((entry) => entry.tab)).toContain('model');
    expect(searchSettings(zh.settings.tabs.mcp).map((entry) => entry.tab)).toContain('mcp');
    expect(searchSettings(zh.settings.tabs.skills).map((entry) => entry.tab)).toContain('skills');
    expect(searchSettings(zh.settings.tabs.channels).map((entry) => entry.tab)).toContain('channels');
    expect(searchSettings(zh.settings.tabs.memory).map((entry) => entry.tab)).toContain('memory');
    expect(searchSettings(zh.settings.tabs.automation).map((entry) => entry.tab)).toContain('automation');
    expect(searchSettings(zh.settings.tabs.workspace).map((entry) => entry.tab)).toContain('workspace');
    expect(searchSettings(en.settings.tabs.workspace).map((entry) => entry.tab)).toContain('workspace');
  });

  it('covers permission/privacy boundary search terms', () => {
    expect(searchSettings(zh.settings.searchIndex.voiceTranscription).map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings(zh.settings.searchIndex.diagnosticBundle).map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings('channel token').map((entry) => entry.tab)).toContain('channels');
    expect(searchSettings('MCP OAuth').map((entry) => entry.tab)).toContain('mcp');
    expect(searchSettings('browser relay').map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings(zh.settings.searchIndex.pluginPermissions, { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
    expect(searchSettings('progress spam').map((entry) => entry.tab)).toContain('channels');
  });

  it('only references registered settings tabs', () => {
    const registered = new Set<string>(SETTINGS_TAB_IDS);
    for (const entry of SETTINGS_INDEX) {
      expect(registered.has(entry.tab)).toBe(true);
    }
  });
});
