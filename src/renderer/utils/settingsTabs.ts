// ============================================================================
// Settings Tab Registry
// Shared tab ids and group placement for settings navigation/search/store.
// ============================================================================

export const SETTINGS_TAB_IDS = [
  'general',
  'conversation',
  'model',
  'appearance',
  'cache',
  'mcp',
  'skills',
  'channels',
  'memory',
  'openchronicle',
  'update',
  'about',
] as const;

export type SettingsTab = typeof SETTINGS_TAB_IDS[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';

export type SettingsTabGroupId = 'basics' | 'connections' | 'memory' | 'system';

export const SETTINGS_TAB_GROUP_LABELS: Record<SettingsTabGroupId, string> = {
  basics: '基础偏好',
  connections: '能力与连接',
  memory: '记忆与隐私',
  system: '系统',
};

export const SETTINGS_TAB_GROUP_ORDER: SettingsTabGroupId[] = [
  'basics',
  'connections',
  'memory',
  'system',
];

export const SETTINGS_TAB_GROUP_BY_TAB: Record<SettingsTab, SettingsTabGroupId> = {
  general: 'basics',
  conversation: 'basics',
  model: 'basics',
  appearance: 'basics',
  mcp: 'connections',
  skills: 'connections',
  channels: 'connections',
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
