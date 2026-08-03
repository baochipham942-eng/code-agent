// ============================================================================
// Settings Feature - Unified Exports
// ============================================================================

import React from 'react';

// Main Entry
export { SettingsModal } from './SettingsModal';

// Tab Components: keep the barrel API without evaluating tab modules when the
// settings entry is loaded. SettingsModal owns the canonical tab loaders.
export const ModelSettings = React.lazy(() => import('./tabs/ModelSettings').then(({ ModelSettings: component }) => ({
  default: component,
})));
export type { ModelConfig, ModelSettingsProps } from './tabs/ModelSettings';

export const AppearanceSettings = React.lazy(() => import('./tabs/AppearanceSettings').then(({ AppearanceSettings: component }) => ({
  default: component,
})));

export const DataSettings = React.lazy(() => import('./tabs/DataSettings').then(({ DataSettings: component }) => ({
  default: component,
})));
export type { DataStats } from './tabs/DataSettings';

export const UpdateSettings = React.lazy(() => import('./tabs/UpdateSettings').then(({ UpdateSettings: component }) => ({
  default: component,
})));
export type { UpdateSettingsProps } from './tabs/UpdateSettings';

export const AboutSettings = React.lazy(() => import('./tabs/AboutSettings').then(({ AboutSettings: component }) => ({
  default: component,
})));
