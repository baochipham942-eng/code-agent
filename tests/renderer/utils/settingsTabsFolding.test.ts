// ============================================================================
// Settings IA 收敛（maka⑤批·v2 纯分组方案）
// ============================================================================
// 26 tab / 6 组 → 默认 5 组 19 项 + 「高级」折叠组 7 项（含 capabilities 深链占位）。
// v2 拍板要点（产品负责人 2026-07-03）：
//   - hooks 下放普通用户；plugins 在能力中心仅管理员可见
//   - 不引入开发者模式开关——技术项收进默认折叠的「高级」组，点开即用
// 2026-07 方案 9C：admin 管理组（users/invites/controlPlane/capabilities）迁 admin-console，
//   组定义删除；users/invites/controlPlane 深链移除，capabilities 仅留 id 重定向能力中心
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_TAB_IDS,
  SETTINGS_TAB_GROUP_BY_TAB,
  SETTINGS_TAB_GROUP_ORDER,
  COLLAPSED_SETTINGS_TAB_GROUPS,
  CAPABILITY_HUB_TAB_BY_SETTINGS_TAB,
  canAccessSettingsTab,
} from '../../../src/renderer/utils/settingsTabs';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('Settings IA 分组 v2', () => {
  it('每个 tab 都有组，且组在排序表里', () => {
    for (const tab of SETTINGS_TAB_IDS) {
      const group = SETTINGS_TAB_GROUP_BY_TAB[tab];
      expect(group, `tab ${tab} 缺组`).toBeTruthy();
      expect(SETTINGS_TAB_GROUP_ORDER, `组 ${group} 不在排序表`).toContain(group);
    }
  });

  it('高级组收纳 7 个技术项（含 capabilities 深链占位）', () => {
    const advanced = SETTINGS_TAB_IDS.filter((t) => SETTINGS_TAB_GROUP_BY_TAB[t] === 'advanced');
    expect(advanced.sort()).toEqual(
      ['agentEngine', 'appshots', 'cache', 'capabilities', 'hooks', 'mcp', 'plugins'].sort(),
    );
  });

  it('管理组已删除：users/invites/controlPlane 不再是注册 tab', () => {
    expect(SETTINGS_TAB_IDS).not.toContain('users');
    expect(SETTINGS_TAB_IDS).not.toContain('invites');
    expect(SETTINGS_TAB_IDS).not.toContain('controlPlane');
    expect(SETTINGS_TAB_GROUP_ORDER).not.toContain('management');
  });

  it('普通用户不能访问 plugins，管理员可访问，hooks 仍开放', () => {
    expect(canAccessSettingsTab('plugins', { isAdmin: false })).toBe(false);
    expect(canAccessSettingsTab('plugins', { isAdmin: true })).toBe(true);
    expect(canAccessSettingsTab('hooks', { isAdmin: false })).toBe(true);
  });

  it('除 plugins 外其余注册 tab 对普通用户开放', () => {
    for (const tab of SETTINGS_TAB_IDS) {
      expect(canAccessSettingsTab(tab, { isAdmin: false }), tab).toBe(tab !== 'plugins');
    }
  });

  it('保留 plugins 深链到能力中心的映射', () => {
    expect(CAPABILITY_HUB_TAB_BY_SETTINGS_TAB.plugins).toBe('plugins');
  });

  it('高级组默认折叠，其余组不折叠', () => {
    expect(COLLAPSED_SETTINGS_TAB_GROUPS.has('advanced')).toBe(true);
    expect(COLLAPSED_SETTINGS_TAB_GROUPS.size).toBe(1);
  });

  it('普通用户默认展开可见 20 项（5 组），排除高级折叠组', () => {
    const visible = SETTINGS_TAB_IDS.filter((t) => {
      const group = SETTINGS_TAB_GROUP_BY_TAB[t];
      return group !== 'advanced' && canAccessSettingsTab(t, { isAdmin: false });
    });
    expect(visible).toHaveLength(20);
  });

  it('组标签齐全（zh/en，单一真源 i18n）且默认组序为 5 常规组 + 高级', () => {
    for (const group of SETTINGS_TAB_GROUP_ORDER) {
      expect(zh.settings.tabGroups[group], `zh 缺组标签 ${group}`).toBeTruthy();
      expect(en.settings.tabGroups[group], `en 缺组标签 ${group}`).toBeTruthy();
    }
    expect(SETTINGS_TAB_GROUP_ORDER).toHaveLength(6);
    expect(SETTINGS_TAB_GROUP_ORDER[SETTINGS_TAB_GROUP_ORDER.length - 1]).toBe('advanced');
  });
});
