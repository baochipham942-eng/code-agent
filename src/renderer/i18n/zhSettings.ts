// ============================================================================
// Settings namespace translations (zh) — 装配器（分域模块见 zhSettingsCore/Models/Work/System）
// ============================================================================

import { zhSettingsCore } from './zhSettingsCore';
import { zhSettingsModels } from './zhSettingsModels';
import { zhSettingsWork } from './zhSettingsWork';
import { zhSettingsSystem } from './zhSettingsSystem';

export const zhSettings = {
    title: '设置',
    backToApp: '返回应用',
    searchPlaceholder: '搜索设置...',
    searchNoResults: '未找到匹配的设置项',
  ...zhSettingsCore,
  ...zhSettingsModels,
  ...zhSettingsWork,
  ...zhSettingsSystem,
};
