// ============================================================================
// Settings IA 收敛（maka⑤批·v2 纯分组方案）
// ============================================================================
// 29 tab / 7 组 → 默认 5 组 19 项 + 「高级」折叠组 6 项 + admin 组 4 项。
// v2 拍板要点（产品负责人 2026-07-03）：
//   - plugins/hooks 下放普通用户（可自行配置，不再 admin-only）
//   - 不引入开发者模式开关——技术项收进默认折叠的「高级」组，点开即用
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_TAB_IDS,
  SETTINGS_TAB_GROUP_BY_TAB,
  SETTINGS_TAB_GROUP_ORDER,
  COLLAPSED_SETTINGS_TAB_GROUPS,
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

  it('高级组收纳 6 个技术项', () => {
    const advanced = SETTINGS_TAB_IDS.filter((t) => SETTINGS_TAB_GROUP_BY_TAB[t] === 'advanced');
    expect(advanced.sort()).toEqual(
      ['agentEngine', 'appshots', 'cache', 'hooks', 'mcp', 'plugins'].sort(),
    );
  });

  it('管理组只剩 4 个 admin 项', () => {
    const management = SETTINGS_TAB_IDS.filter((t) => SETTINGS_TAB_GROUP_BY_TAB[t] === 'management');
    expect(management.sort()).toEqual(
      ['capabilities', 'controlPlane', 'invites', 'users'].sort(),
    );
  });

  it('普通用户可访问 plugins/hooks（v2 下放）', () => {
    expect(canAccessSettingsTab('plugins', { isAdmin: false })).toBe(true);
    expect(canAccessSettingsTab('hooks', { isAdmin: false })).toBe(true);
  });

  it('管理项对普通用户仍不可见', () => {
    for (const tab of ['users', 'invites', 'controlPlane', 'capabilities'] as const) {
      expect(canAccessSettingsTab(tab, { isAdmin: false }), tab).toBe(false);
      expect(canAccessSettingsTab(tab, { isAdmin: true }), tab).toBe(true);
    }
  });

  it('高级组默认折叠，其余组不折叠', () => {
    expect(COLLAPSED_SETTINGS_TAB_GROUPS.has('advanced')).toBe(true);
    expect(COLLAPSED_SETTINGS_TAB_GROUPS.size).toBe(1);
  });

  it('普通用户默认展开可见 19 项（5 组），排除高级/管理组', () => {
    const visible = SETTINGS_TAB_IDS.filter((t) => {
      const group = SETTINGS_TAB_GROUP_BY_TAB[t];
      return group !== 'advanced' && group !== 'management' && canAccessSettingsTab(t, { isAdmin: false });
    });
    expect(visible).toHaveLength(19);
  });

  it('组标签齐全（zh/en，单一真源 i18n）且默认组序为 5 常规组 + 高级 + 管理', () => {
    for (const group of SETTINGS_TAB_GROUP_ORDER) {
      expect(zh.settings.tabGroups[group], `zh 缺组标签 ${group}`).toBeTruthy();
      expect(en.settings.tabGroups[group], `en 缺组标签 ${group}`).toBeTruthy();
    }
    expect(SETTINGS_TAB_GROUP_ORDER).toHaveLength(7);
    expect(SETTINGS_TAB_GROUP_ORDER[SETTINGS_TAB_GROUP_ORDER.length - 1]).toBe('management');
    expect(SETTINGS_TAB_GROUP_ORDER[SETTINGS_TAB_GROUP_ORDER.length - 2]).toBe('advanced');
  });
});
