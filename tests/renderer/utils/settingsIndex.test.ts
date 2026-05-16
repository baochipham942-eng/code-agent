import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, searchSettings } from '../../../src/renderer/utils/settingsIndex';
import { SETTINGS_TAB_IDS } from '../../../src/renderer/utils/settingsTabs';

describe('settings search index', () => {
  it('covers conversation settings', () => {
    expect(searchSettings('路由').map((entry) => entry.tab)).toContain('conversation');
  });

  it('routes browser settings to workspace settings', () => {
    expect(searchSettings('browser').map((entry) => entry.tab)).toContain('workspace');
  });

  it('covers capability center settings for admins', () => {
    expect(searchSettings('capability', { isAdmin: true }).map((entry) => entry.tab)).toContain('capabilities');
    expect(searchSettings('MCP', { isAdmin: true }).map((entry) => entry.tab)).toContain('capabilities');
  });

  it('routes config scope searches to workspace settings', () => {
    expect(searchSettings('config scope').map((entry) => entry.tab)).toContain('workspace');
    expect(searchSettings('配置作用域').map((entry) => entry.tab)).toContain('workspace');
  });

  it('covers user and invite management settings', () => {
    expect(searchSettings('上次登录', { isAdmin: true }).map((entry) => entry.tab)).toContain('users');
    expect(searchSettings('邀请码', { isAdmin: true }).map((entry) => entry.tab)).toContain('invites');
  });

  it('hides admin-only settings from non-admin search results', () => {
    expect(searchSettings('上次登录').map((entry) => entry.tab)).not.toContain('users');
    expect(searchSettings('邀请码').map((entry) => entry.tab)).not.toContain('invites');
    expect(searchSettings('capability').map((entry) => entry.tab)).not.toContain('capabilities');
    expect(searchSettings('Hook').map((entry) => entry.tab)).not.toContain('hooks');
  });

  it('keeps personal settings searchable for non-admin users', () => {
    expect(searchSettings('模型').map((entry) => entry.tab)).toContain('model');
    expect(searchSettings('MCP').map((entry) => entry.tab)).toContain('mcp');
    expect(searchSettings('Skill').map((entry) => entry.tab)).toContain('skills');
    expect(searchSettings('通道').map((entry) => entry.tab)).toContain('channels');
    expect(searchSettings('记忆').map((entry) => entry.tab)).toContain('memory');
    expect(searchSettings('自动化').map((entry) => entry.tab)).toContain('automation');
    expect(searchSettings('工作区').map((entry) => entry.tab)).toContain('workspace');
  });

  it('only references registered settings tabs', () => {
    const registered = new Set<string>(SETTINGS_TAB_IDS);
    for (const entry of SETTINGS_INDEX) {
      expect(registered.has(entry.tab)).toBe(true);
    }
  });
});
