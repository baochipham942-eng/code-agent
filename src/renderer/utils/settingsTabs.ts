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
  'search',
  'voiceInput',
  'keybindings',
  'model',
  'visualModels',
  'agentEngine',
  'appearance',
  'soul',
  'workspace',
  'automation',
  'appshots',
  'users',
  'invites',
  'controlPlane',
  'cache',
  'capabilities',
  'plugins',
  'mcp',
  'skills',
  'roles',
  'channels',
  'hooks',
  'memory',
  'openchronicle',
  'privacy',
  'update',
  'about',
] as const;

export type SettingsTab = typeof SETTINGS_TAB_IDS[number];

// 能力中心的顶层 tab（ADR-049）。单一真源放在 tab 注册表这里，appStore 只做 re-export。
export type CapabilityHubTab =
  | 'experts'
  | 'skills'
  | 'connectors'
  | 'plugins';

// 能力中心是专家 / 技能 / 连接器 / 插件的唯一入口；SettingsTab id 仍保留给搜索和深链入口。
export const CAPABILITY_HUB_TAB_BY_SETTINGS_TAB: Partial<Record<SettingsTab, CapabilityHubTab>> = {
  roles: 'experts',
  skills: 'skills',
  mcp: 'connectors',
  plugins: 'plugins',
};

/** `openSettingsTab(id)` 的落点：这些 id 保留着只是让老深链继续可用，落点未必还在设置页。 */
export type SettingsDeepLinkTarget =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'capabilityHub'; tab: CapabilityHubTab }
  | { kind: 'cronCenter' };

/**
 * 深链落点单点判定（ADR-049 §收窄）：自动化去独立的自动化面板，
 * 能力中心那四项去能力中心，其余照常开设置页。
 * 放在 tab 注册表这里而不是 store 里，是为了让「id → 落点」只有一处可改——
 * 设置页搜索也走它，否则搜「自动化」会把 activeTab 设成一个已不存在的 tab。
 */
export function resolveSettingsDeepLink(tab: SettingsTab): SettingsDeepLinkTarget {
  if (tab === 'automation') return { kind: 'cronCenter' };
  const hubTab = CAPABILITY_HUB_TAB_BY_SETTINGS_TAB[tab];
  return hubTab ? { kind: 'capabilityHub', tab: hubTab } : { kind: 'settings', tab };
}

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'model';

// Settings IA 收敛（maka⑤批 v2 拍板 2026-07-03）：面向非程序员协作者，
// 默认 5 组 19 项；技术项收进默认折叠的「高级」组（点开即用，不设开关）；
// admin 项独立「管理」组（现有 canAccessSettingsTab 门控）。
export type SettingsTabGroupId =
  | 'models'
  | 'basics'
  | 'work'
  | 'memory'
  | 'system'
  | 'advanced'
  | 'management';

// 组标签单一真源在 i18n：t.settings.tabGroups（zh/en 对齐），此处不再维护文案副本

export const SETTINGS_TAB_GROUP_ORDER: SettingsTabGroupId[] = [
  'models',
  'basics',
  'work',
  'memory',
  'system',
  'advanced',
  'management',
];

/** 侧栏默认折叠的组（无权限语义，点组头展开） */
export const COLLAPSED_SETTINGS_TAB_GROUPS: ReadonlySet<SettingsTabGroupId> = new Set(['advanced']);

export const SETTINGS_TAB_GROUP_BY_TAB: Record<SettingsTab, SettingsTabGroupId> = {
  // 基础偏好
  general: 'basics',
  conversation: 'basics',
  appearance: 'basics',
  keybindings: 'basics',
  voiceInput: 'basics',
  // 模型与能力
  model: 'models',
  visualModels: 'models',
  search: 'models',
  soul: 'models',
  skills: 'models',
  // 工作与协作
  workspace: 'work',
  automation: 'work',
  channels: 'work',
  roles: 'work',
  // 记忆与隐私
  memory: 'memory',
  openchronicle: 'memory',
  privacy: 'memory',
  // 系统
  update: 'system',
  about: 'system',
  // 高级（默认折叠，普通用户可自行配置）
  agentEngine: 'advanced',
  mcp: 'advanced',
  plugins: 'advanced',
  hooks: 'advanced',
  appshots: 'advanced',
  cache: 'advanced',
  // 管理（仅 admin）
  users: 'management',
  invites: 'management',
  controlPlane: 'management',
  capabilities: 'management',
};

// v2 拍板：plugins/hooks 下放普通用户（自行配置），从门控表移除
const SETTINGS_TAB_ACCESS_FEATURES: Partial<Record<SettingsTab, AccessControlledFeature>> = {
  users: 'settings.users',
  invites: 'settings.invites',
  controlPlane: 'settings.controlPlane',
  capabilities: 'settings.capabilities',
};

export function canAccessSettingsTab(tab: SettingsTab, subject?: AccessSubject | null): boolean {
  const feature = SETTINGS_TAB_ACCESS_FEATURES[tab];
  if (!feature) return true;
  return canAccessFeature(feature, subject);
}
