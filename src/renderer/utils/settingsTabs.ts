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
  'voiceLive',
  'voiceInput',
  'keybindings',
  'doctor',
  'model',
  'visualModels',
  'voiceModel',
  'agentEngine',
  'appearance',
  'soul',
  'workspace',
  'automation',
  'appshots',
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
// capabilities（旧能力治理 tab，管理组迁 admin-console 后下线）同样重定向进能力中心默认 tab。
export const CAPABILITY_HUB_TAB_BY_SETTINGS_TAB: Partial<Record<SettingsTab, CapabilityHubTab>> = {
  roles: 'experts',
  skills: 'skills',
  mcp: 'connectors',
  plugins: 'plugins',
  capabilities: 'experts',
};

/** `openSettingsTab(id)` 的落点：这些 id 保留着只是让老深链继续可用，落点未必还在设置页。 */
export type SettingsDeepLinkTarget =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'capabilityHub'; tab: CapabilityHubTab }
  | { kind: 'cronCenter' };

/**
 * 深链落点单点判定（ADR-049 §收窄）：自动化去独立的自动化面板，
 * 能力中心那几项（含旧 capabilities 治理 tab）去能力中心，其余照常开设置页。
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
// 默认 5 组 19 项；技术项收进默认折叠的「高级」组（点开即用，不设开关）。
// 2026-07 导航去重（方案 9C）：原 admin「管理」组（users/invites/controlPlane/capabilities）
// 整体迁往独立 admin-console，桌面 app 不再提供——组定义删除，
// users/invites/controlPlane 深链一并移除，capabilities 仅留 id 作深链重定向（进能力中心）。
export type SettingsTabGroupId =
  | 'models'
  | 'basics'
  | 'work'
  | 'memory'
  | 'system'
  | 'advanced';

// 组标签单一真源在 i18n：t.settings.tabGroups（zh/en 对齐），此处不再维护文案副本

export const SETTINGS_TAB_GROUP_ORDER: SettingsTabGroupId[] = [
  'models',
  'basics',
  'work',
  'memory',
  'system',
  'advanced',
];

/** 侧栏默认折叠的组（无权限语义，点组头展开） */
export const COLLAPSED_SETTINGS_TAB_GROUPS: ReadonlySet<SettingsTabGroupId> = new Set(['advanced']);

export const SETTINGS_TAB_GROUP_BY_TAB: Record<SettingsTab, SettingsTabGroupId> = {
  // 基础偏好
  general: 'basics',
  conversation: 'basics',
  appearance: 'basics',
  keybindings: 'basics',
  voiceLive: 'basics',
  voiceInput: 'basics',
  // 全量诊断：系统级能力，独立菜单项（工单③b 返工拍板）
  doctor: 'basics',
  // 模型与能力
  model: 'models',
  visualModels: 'models',
  // T1（2026-07-28）：通话模型/音色/转写模型从 voiceLive/voiceInput 收拢到独立 tab
  voiceModel: 'models',
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
  // 高级（默认折叠；plugins 仅管理员可见，其余项普通用户可配置）
  agentEngine: 'advanced',
  mcp: 'advanced',
  plugins: 'advanced',
  hooks: 'advanced',
  appshots: 'advanced',
  cache: 'advanced',
  // capabilities 仅作深链落点（重定向能力中心），不会出现在设置导航；组归属仅为注册表完整性
  capabilities: 'advanced',
};

// 插件配置只对管理员开放；tab id 继续保留，供管理员深链与能力中心映射使用。
const SETTINGS_TAB_ACCESS_FEATURES: Partial<Record<SettingsTab, AccessControlledFeature>> = {
  plugins: 'settings.plugins',
};

export function canAccessSettingsTab(tab: SettingsTab, subject?: AccessSubject | null): boolean {
  const feature = SETTINGS_TAB_ACCESS_FEATURES[tab];
  if (!feature) return true;
  return canAccessFeature(feature, subject);
}
