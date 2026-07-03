// ============================================================================
// Settings 内容区 i18n 迁移棘轮
// 已迁文件（MIGRATED）源码中禁止再出现中文字面量（注释除外）——防回潮硬闸。
// 迁移一个文件就把它加进 MIGRATED；全部迁完后本清单 = tabs 全量。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');
const SETTINGS_DIR = path.join(RENDERER_DIR, 'components/features/settings');

/** 已完成 i18n 迁移的文件（相对 settings 目录）。只增不减。 */
const MIGRATED: string[] = [
  'tabs/AppearanceSettings.tsx',
  'tabs/GeneralSettings.tsx',
  'tabs/ConversationSettings.tsx',
  'tabs/KeybindingsSettings.tsx',
  'tabs/VoiceInputSettings.tsx',
  'tabs/ModelSettings.tsx',
  'tabs/ModelSettings.helpers.tsx',
  'tabs/ProviderListPanel.tsx',
  'tabs/ProviderModelsSection.tsx',
  'tabs/ProviderDetailSections.tsx',
  'tabs/TaskStrategySettingsPanel.tsx',
  'tabs/BudgetSettings.tsx',
  'tabs/SkillsSettings.tsx',
  'tabs/SkillsInstalledTab.tsx',
  'tabs/SkillsDiscoverTab.tsx',
  'tabs/SkillsSettingsCards.tsx',
  'tabs/MCPSettings.tsx',
  'tabs/McpDiscoverTab.tsx',
  'tabs/PluginsSettings.tsx',
  'tabs/WorkspaceSettings.tsx',
  'tabs/AutomationSettings.tsx',
  'tabs/ChannelsSettings.tsx',
  'tabs/MemoryTab.tsx',
  'tabs/MemoryEntriesManager.tsx',
  'tabs/PrivacySettings.tsx',
  'tabs/ScreenMemorySettings.tsx',
  'tabs/OpenchronicleSettings.tsx',
  'tabs/UpdateSettings.tsx',
  'tabs/DataSettings.tsx',
  'tabs/AppshotsSettings.tsx',
  'tabs/SoulSettings.tsx',
  'tabs/SearchSettings.tsx',
  'tabs/HooksSettings.tsx',
  'tabs/RolesTab.tsx',
  'tabs/VisualModelsSettings.tsx',
  'tabs/CapabilityCenterSettings.tsx',
  'tabs/UserDashboardSettings.tsx',
  'tabs/InviteCodesSettings.tsx',
  'tabs/ControlPlaneSettings.tsx',
  'tabs/AlmaRegistryAuditPanel.tsx',
  'tabs/AddProviderCard.tsx',
  'sections/NativeDesktopSection.tsx',
  'sections/NativeConnectorsSection.tsx',
  'sections/nativeDesktopActivityModel.ts',
  'sections/localBridge/SecurityLevelConfig.tsx',
  'sections/localBridge/WorkingDirectoryPicker.tsx',
  'sections/localBridge/InstallGuide.tsx',
  'sections/localBridge/VersionInfo.tsx',
  'sections/localBridge/StatusIndicator.tsx',
  'sections/localBridge/LocalBridgeSection.tsx',
  'ProviderDoctorDialog.tsx',
  'McpServerEditor.tsx',
  'SettingsModal.tsx',
  'WebModeBanner.tsx',
];

/** Settings 迁移涉及的非 settings 目录文件（相对 src/renderer）。 */
const EXTRA_FILES: string[] = [
  'utils/settingsIndex.ts',
];

const HAN_RE = /[一-鿿]/;
// 反逃逸：一-鿿 区间的 unicode 转义写法同样算中文字面量（实测批7出现过 '打开' 绕闸）
const HAN_ESCAPE_RE = /\\u(?:4[e-f]|[5-8][0-9a-f]|9[0-9a-f])[0-9a-f]{2}/i;

/** 去掉行注释、块注释、JSX 注释后再扫描，避免中文注释误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/[^'"\n]*$/gm, '$1');
}

const SCAN_TARGETS = [
  ...MIGRATED.map((rel) => ({ rel, abs: path.join(SETTINGS_DIR, rel) })),
  ...EXTRA_FILES.map((rel) => ({ rel, abs: path.join(RENDERER_DIR, rel) })),
];

describe('Settings 内容区 i18n 棘轮（已迁文件无中文字面量）', () => {
  it('MIGRATED 与 EXTRA_FILES 清单内的文件都存在', () => {
    for (const target of SCAN_TARGETS) {
      expect(fs.existsSync(target.abs), `${target.rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  for (const target of SCAN_TARGETS) {
    it(`已迁文件无中文字面量: ${target.rel}`, () => {
      const source = fs.readFileSync(target.abs, 'utf-8');
      const code = stripComments(source);
      const offending = code
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => HAN_RE.test(line) || HAN_ESCAPE_RE.test(line));
      expect(
        offending.map(({ no, line }) => `L${no}: ${line.slice(0, 80)}`),
        `${target.rel} 还有 ${offending.length} 处中文字面量`,
      ).toEqual([]);
    });
  }
});
