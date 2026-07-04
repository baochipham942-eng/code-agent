// ============================================================================
// Settings namespace translations (en) — 装配器（分域模块见 enSettingsCore/Models/Work/System）
// ============================================================================

import { enSettingsCore } from './enSettingsCore';
import { enSettingsModels } from './enSettingsModels';
import { enSettingsWork } from './enSettingsWork';
import { enSettingsSystem } from './enSettingsSystem';

export const enSettings = {
    title: 'Settings',
    backToApp: 'Back to app',
    searchPlaceholder: 'Search settings...',
    searchNoResults: 'No matching settings',
  ...enSettingsCore,
  ...enSettingsModels,
  ...enSettingsWork,
  ...enSettingsSystem,
};
