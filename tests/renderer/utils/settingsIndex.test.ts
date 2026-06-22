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

  it('covers new model-group tabs (generation models & search sources)', () => {
    expect(searchSettings('生成模型').map((entry) => entry.tab)).toContain('imageVideo');
    expect(searchSettings('视频').map((entry) => entry.tab)).toContain('imageVideo');
    expect(searchSettings('搜索源').map((entry) => entry.tab)).toContain('search');
    expect(searchSettings('tavily').map((entry) => entry.tab)).toContain('search');
  });

  it('covers capability center settings for admins', () => {
    expect(searchSettings('capability', { isAdmin: true }).map((entry) => entry.tab)).toContain('capabilities');
    expect(searchSettings('MCP', { isAdmin: true }).map((entry) => entry.tab)).toContain('capabilities');
  });

  it('covers plugin management settings for admins', () => {
    expect(searchSettings('插件市场', { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
    expect(searchSettings('仅管理员可见', { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
  });

  it('routes config scope searches to workspace settings', () => {
    expect(searchSettings('config scope').map((entry) => entry.tab)).toContain('workspace');
    expect(searchSettings('配置作用域').map((entry) => entry.tab)).toContain('workspace');
  });

  it('covers user and invite management settings', () => {
    expect(searchSettings('用户管理', { isAdmin: true }).map((entry) => entry.tab)).toContain('users');
    expect(searchSettings('上次登录', { isAdmin: true }).map((entry) => entry.tab)).toContain('users');
    expect(searchSettings('邀请码管理', { isAdmin: true }).map((entry) => entry.tab)).toContain('invites');
    expect(searchSettings('邀请码', { isAdmin: true }).map((entry) => entry.tab)).toContain('invites');
    expect(searchSettings('control plane', { isAdmin: true }).map((entry) => entry.tab)).toContain('controlPlane');
    expect(searchSettings('发布审计', { isAdmin: true }).map((entry) => entry.tab)).toContain('controlPlane');
  });

  it('hides admin-only settings from non-admin search results', () => {
    expect(searchSettings('上次登录').map((entry) => entry.tab)).not.toContain('users');
    expect(searchSettings('邀请码').map((entry) => entry.tab)).not.toContain('invites');
    expect(searchSettings('control plane').map((entry) => entry.tab)).not.toContain('controlPlane');
    expect(searchSettings('capability').map((entry) => entry.tab)).not.toContain('capabilities');
    expect(searchSettings('插件市场').map((entry) => entry.tab)).not.toContain('plugins');
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

  it('covers permission/privacy boundary search terms', () => {
    expect(searchSettings('语音转写').map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings('诊断包').map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings('channel token').map((entry) => entry.tab)).toContain('channels');
    expect(searchSettings('MCP OAuth').map((entry) => entry.tab)).toContain('mcp');
    expect(searchSettings('browser relay').map((entry) => entry.tab)).toContain('privacy');
    expect(searchSettings('插件权限', { isAdmin: true }).map((entry) => entry.tab)).toContain('plugins');
    expect(searchSettings('progress spam').map((entry) => entry.tab)).toContain('channels');
  });

  it('only references registered settings tabs', () => {
    const registered = new Set<string>(SETTINGS_TAB_IDS);
    for (const entry of SETTINGS_INDEX) {
      expect(registered.has(entry.tab)).toBe(true);
    }
  });
});
