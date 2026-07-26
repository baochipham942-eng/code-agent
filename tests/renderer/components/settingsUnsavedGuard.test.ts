// ============================================================================
// 设置页保存语义 P0 回归测试（2026-07）
// 覆盖：WIDE_SETTINGS_TABS 恒横滚修复、未保存拦截 i18n、MemoryTab i18n、
//       ModelSettings 保存反馈去 !bg-green-600 硬 hack。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

import { WIDE_SETTINGS_TABS } from '../../../src/renderer/components/features/settings/SettingsModal';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const TABS_DIR = path.resolve(__dirname, '../../../src/renderer/components/features/settings/tabs');

describe('WIDE_SETTINGS_TABS（宽表格 tab 恒横滚修复）', () => {
  it('权限与安全（general）与记忆（memory）走宽版布局', () => {
    // GeneralSettings 有 min-w-[820px] 表格，窄版 max-w-4xl 下恒横向滚动
    expect(WIDE_SETTINGS_TABS.has('general')).toBe(true);
    expect(WIDE_SETTINGS_TABS.has('memory')).toBe(true);
  });
});

describe('未保存拦截 i18n（settings.unsavedChanges）', () => {
  it('zh/en 键对齐且非空', () => {
    const zhKeys = Object.keys(zh.settings.unsavedChanges).sort();
    const enKeys = Object.keys(en.settings.unsavedChanges).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect((zh.settings.unsavedChanges as Record<string, string>)[key]).toBeTruthy();
      expect((en.settings.unsavedChanges as Record<string, string>)[key]).toBeTruthy();
    }
  });
});

describe('MemoryTab i18n（页标题 + 详情 label）', () => {
  it('页标题与侧栏「记忆」一致', () => {
    expect(zh.settings.memory.files.pageTitle).toBe(zh.settings.tabs.memory);
  });

  it('详情 label zh/en 键对齐且非空', () => {
    const zhLabels = zh.settings.memory.files.detailLabels;
    const enLabels = en.settings.memory.files.detailLabels;
    expect(Object.keys(enLabels).sort()).toEqual(Object.keys(zhLabels).sort());
    for (const key of Object.keys(zhLabels) as Array<keyof typeof zhLabels>) {
      expect(zhLabels[key]).toBeTruthy();
      expect(enLabels[key]).toBeTruthy();
    }
  });

  it('MemoryTab 源码不再硬编码英文页标题 / 详情 label', () => {
    const source = fs.readFileSync(path.join(TABS_DIR, 'MemoryTab.tsx'), 'utf-8');
    expect(source).not.toContain('title="Light Memory"');
    expect(source).not.toMatch(/<dt className="[^"]*">(Name|Type|Updated|Chars|Description)<\/dt>/);
  });
});

describe('ModelSettings 保存语义（P0）', () => {
  const source = fs.readFileSync(path.join(TABS_DIR, 'ModelSettings.tsx'), 'utf-8');

  it('保存反馈不再使用 !bg-green-600 硬 hack，走统一 toast 通道', () => {
    expect(source).not.toContain('!bg-green-600');
    expect(source).toContain('toast.success(modelText.toast.configSaved)');
  });

  it('staged-dirty 通过 onDirtyChange 上报（拦截在 SettingsModal 层）', () => {
    expect(source).toContain('onDirtyChange');
    expect(source).toContain('markDirty');
  });

  it('TaskStrategySettingsPanel 标注「自动保存」', () => {
    const panel = fs.readFileSync(path.join(TABS_DIR, 'TaskStrategySettingsPanel.tsx'), 'utf-8');
    expect(panel).toContain('strategyText.autoSaveBadge');
    expect(zh.settings.model.taskStrategy.autoSaveBadge).toBeTruthy();
    expect(en.settings.model.taskStrategy.autoSaveBadge).toBeTruthy();
  });

  it('测试连接旁标注测的是当前编辑中的值', () => {
    const sections = fs.readFileSync(path.join(TABS_DIR, 'ProviderDetailSections.tsx'), 'utf-8');
    expect(sections).toContain('connectionText.testConnectionHint');
    expect(zh.settings.model.connection.testConnectionHint).toBeTruthy();
    expect(en.settings.model.connection.testConnectionHint).toBeTruthy();
  });
});
