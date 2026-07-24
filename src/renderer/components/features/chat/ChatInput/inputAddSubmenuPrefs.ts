export type InputAddSubmenuScope = 'skills' | 'experts' | 'teams' | 'connectors';

export interface InputAddSubmenuPrefs {
  pinnedIds: string[];
  recentIds: string[];
}

const RECENT_LIMIT = 8;
const STORAGE_KEYS: Record<InputAddSubmenuScope, string> = {
  skills: 'code-agent:input-add-submenu:skills',
  experts: 'code-agent:input-add-submenu:experts',
  teams: 'code-agent:input-add-submenu:teams',
  connectors: 'code-agent:input-add-submenu:connectors',
};

const EMPTY_PREFS: InputAddSubmenuPrefs = { pinnedIds: [], recentIds: [] };

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return [];
  return [...new Set(value)];
}

function normalizePrefs(value: unknown): InputAddSubmenuPrefs {
  if (!value || typeof value !== 'object') return { ...EMPTY_PREFS };
  const prefs = value as { pinnedIds?: unknown; recentIds?: unknown };
  return {
    pinnedIds: stringArray(prefs.pinnedIds),
    recentIds: stringArray(prefs.recentIds).slice(0, RECENT_LIMIT),
  };
}

/** 本机输入框「+」二级菜单偏好；存储不可用时始终退化为无偏好。 */
export function readInputAddSubmenuPrefs(scope: InputAddSubmenuScope): InputAddSubmenuPrefs {
  try {
    const serialized = globalThis.localStorage.getItem(STORAGE_KEYS[scope]);
    if (!serialized) return { ...EMPTY_PREFS };
    return normalizePrefs(JSON.parse(serialized));
  } catch {
    return { ...EMPTY_PREFS };
  }
}

export function writeInputAddSubmenuPrefs(scope: InputAddSubmenuScope, prefs: InputAddSubmenuPrefs): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEYS[scope], JSON.stringify(normalizePrefs(prefs)));
  } catch {
    // Local preferences must never block the menu when storage is unavailable.
  }
}

export function recordInputAddSubmenuRecent(prefs: InputAddSubmenuPrefs, id: string): InputAddSubmenuPrefs {
  return {
    ...prefs,
    recentIds: [id, ...prefs.recentIds.filter((recentId) => recentId !== id)].slice(0, RECENT_LIMIT),
  };
}
