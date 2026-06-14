// ============================================================================
// Marketplace Types (shared for IPC)
// Moved from main/skills/marketplace/types.ts to break shared→main dependency
// ============================================================================

// MarketplaceSource without Zod dependency (plain TS union)
export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string; path?: string }
  | { source: 'url'; url: string }
  | { source: 'npm'; package: string }
  | { source: 'directory'; path: string };

export type PluginScope = 'user' | 'project';

export type MarketplacePluginKind =
  | 'skill'
  | 'command'
  | 'ui'
  | 'theme'
  | 'provider'
  | 'tool'
  | 'transform';

export interface MarketplaceInfo {
  name: string;
  description?: string;
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
  autoUpdate?: boolean;
}

export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  marketplace: string;
  source: string;
  types?: MarketplacePluginKind[];
  skills?: string[];
  commands?: string[];
  tags?: string[];
  version?: string;
  author?: string;
  isInstalled?: boolean;
  isEnabled?: boolean;
}

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  scope: PluginScope;
  isEnabled: boolean;
  projectPath?: string;
  installedAt: string;
  pluginRoot?: string;
  types?: MarketplacePluginKind[];
  skills: string[];
  commands?: string[];
}

export interface MarketplaceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PluginInstallResult {
  success: boolean;
  plugin?: InstalledPlugin;
  installedSkills?: string[];
  installedCommands?: string[];
  installedPluginRoot?: string;
  error?: string;
}
