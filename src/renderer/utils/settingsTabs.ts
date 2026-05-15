// ============================================================================
// Settings Tab Registry
// Shared tab ids and group placement for settings navigation/search/store.
// ============================================================================

export const SETTINGS_TAB_IDS = [
  'general',
  'conversation',
  'model',
  'appearance',
  'workspace',
  'automation',
  'cache',
  'capabilities',
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
  | 'memory'
  | 'system'
  | 'advanced';

export const SETTINGS_TAB_GROUP_LABELS: Record<SettingsTabGroupId, string> = {
  basics: '基础偏好',
  connections: '能力与连接',
  workspace: '工作区与自动化',
  memory: '记忆与隐私',
  system: '系统',
  advanced: '高级',
};

export const SETTINGS_TAB_GROUP_ORDER: SettingsTabGroupId[] = [
  'basics',
  'connections',
  'workspace',
  'memory',
  'system',
  'advanced',
];

export const SETTINGS_TAB_GROUP_BY_TAB: Record<SettingsTab, SettingsTabGroupId> = {
  general: 'basics',
  conversation: 'basics',
  model: 'basics',
  appearance: 'basics',
  mcp: 'connections',
  capabilities: 'connections',
  skills: 'connections',
  channels: 'connections',
  hooks: 'advanced',
  workspace: 'workspace',
  automation: 'workspace',
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
