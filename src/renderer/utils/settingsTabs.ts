// ============================================================================
// Settings Tab Registry
// Shared tab ids and group placement for settings navigation/search/store.
// ============================================================================

import {
  canAccessFeature,
  type AccessControlledFeature,
  type AccessSubject,
} from './accessControl';

export const SETTINGS_TAB_IDS = [
  'general',
  'conversation',
  'model',
  'appearance',
  'soul',
  'workspace',
  'automation',
  'users',
  'invites',
  'controlPlane',
  'cache',
  'capabilities',
  'plugins',
  'mcp',
  'skills',
  'channels',
  'hooks',
  'memory',
  'openchronicle',
  'update',
  'about',
] as const;

export type SettingsTab = typeof SETTINGS_TAB_IDS[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';

export type SettingsTabGroupId =
  | 'basics'
  | 'connections'
  | 'workspace'
  | 'management'
  | 'memory'
  | 'system';

export const SETTINGS_TAB_GROUP_LABELS: Record<SettingsTabGroupId, string> = {
  basics: '基础偏好',
  connections: '能力与连接',
  workspace: '工作区与自动化',
  management: '用户管理',
  memory: '记忆与隐私',
  system: '系统',
};

export const SETTINGS_TAB_GROUP_ORDER: SettingsTabGroupId[] = [
  'basics',
  'connections',
  'workspace',
  'management',
  'memory',
  'system',
];

export const SETTINGS_TAB_GROUP_BY_TAB: Record<SettingsTab, SettingsTabGroupId> = {
  general: 'basics',
  conversation: 'basics',
  model: 'basics',
  appearance: 'basics',
  soul: 'basics',
  mcp: 'connections',
  capabilities: 'connections',
  plugins: 'connections',
  skills: 'connections',
  channels: 'connections',
  hooks: 'connections',
  workspace: 'workspace',
  automation: 'workspace',
  users: 'management',
  invites: 'management',
  controlPlane: 'management',
  memory: 'memory',
  openchronicle: 'memory',
  cache: 'system',
  update: 'system',
  about: 'system',
};

const SETTINGS_TAB_ID_SET = new Set<string>(SETTINGS_TAB_IDS);

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && SETTINGS_TAB_ID_SET.has(value);
}

export const ADMIN_ONLY_SETTINGS_TABS = ['users', 'invites', 'controlPlane', 'capabilities', 'plugins', 'hooks'] as const satisfies readonly SettingsTab[];

const ADMIN_ONLY_SETTINGS_TAB_SET = new Set<SettingsTab>(ADMIN_ONLY_SETTINGS_TABS);

const SETTINGS_TAB_ACCESS_FEATURES: Partial<Record<SettingsTab, AccessControlledFeature>> = {
  users: 'settings.users',
  invites: 'settings.invites',
  controlPlane: 'settings.controlPlane',
  capabilities: 'settings.capabilities',
  plugins: 'settings.plugins',
  hooks: 'settings.hooks',
};

export function isAdminOnlySettingsTab(tab: SettingsTab): boolean {
  return ADMIN_ONLY_SETTINGS_TAB_SET.has(tab);
}

export function canAccessSettingsTab(tab: SettingsTab, subject?: AccessSubject | null): boolean {
  const feature = SETTINGS_TAB_ACCESS_FEATURES[tab];
  if (!feature) return true;
  return canAccessFeature(feature, subject);
}
