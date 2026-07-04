// ============================================================================
// 设置导航 i18n 完整性测试
// IA v2 导航此前 19/29 个 tab label + 7 个组标签硬编码中文，en 态中英混排。
// 兜底：tabs/tabGroups 键覆盖全量 id + zh/en 对齐 + en 态导航无中文字符。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import {
  SETTINGS_TAB_IDS,
  SETTINGS_TAB_GROUP_ORDER,
} from '../../../src/renderer/utils/settingsTabs';
import { buildSettingsTabGroups } from '../../../src/renderer/components/features/settings/SettingsModal';

const HAN_RE = /[一-鿿]/;

describe('设置导航 i18n（settings.tabs / settings.tabGroups）', () => {
  it('settings.tabs 覆盖全部 tab id 且 zh/en 均非空', () => {
    for (const lang of [zh, en] as const) {
      const tabs = lang.settings.tabs as Record<string, string>;
      for (const id of SETTINGS_TAB_IDS) {
        if (id === 'agentEngine') continue; // 走 engineCompat.engineSection.title
        expect(tabs[id], `settings.tabs.${id} 缺失`).toBeTruthy();
      }
    }
    expect(Object.keys(en.settings.tabs).sort()).toEqual(Object.keys(zh.settings.tabs).sort());
  });

  it('settings.tabGroups 覆盖全部组 id 且 zh/en 均非空', () => {
    for (const lang of [zh, en] as const) {
      const groups = lang.settings.tabGroups as Record<string, string>;
      for (const id of SETTINGS_TAB_GROUP_ORDER) {
        expect(groups[id], `settings.tabGroups.${id} 缺失`).toBeTruthy();
      }
    }
    expect(Object.keys(en.settings.tabGroups).sort()).toEqual(Object.keys(zh.settings.tabGroups).sort());
  });

  it('en 态导航（tab label + 组标签）不含中文字符', () => {
    const groups = buildSettingsTabGroups({
      t: en,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: false,
      access: { isAdmin: true },
    });
    for (const group of groups) {
      expect(HAN_RE.test(group.label), `组标签仍是中文: ${group.label}`).toBe(false);
      for (const tab of group.tabs) {
        expect(HAN_RE.test(tab.label), `tab ${tab.id} label 仍是中文: ${tab.label}`).toBe(false);
      }
    }
  });

  it('zh 态导航保持既有中文标签（IA v2 拍板文案不漂移）', () => {
    const groups = buildSettingsTabGroups({
      t: zh,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: false,
      access: { isAdmin: true },
    });
    expect(groups.map((g) => g.label)).toEqual([
      '模型与能力', '基础偏好', '工作与协作', '记忆与隐私', '系统', '高级', '用户管理',
    ]);
    const labelById = new Map(groups.flatMap((g) => g.tabs.map((tab) => [tab.id, tab.label] as const)));
    expect(labelById.get('search')).toBe('搜索源');
    expect(labelById.get('general')).toBe('权限与安全');
    expect(labelById.get('workspace')).toBe('工作区');
    expect(labelById.get('privacy')).toBe('隐私防线');
    expect(labelById.get('cache')).toBe('数据与存储');
  });
});
