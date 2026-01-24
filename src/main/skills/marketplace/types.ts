// ============================================================================
// Skill Marketplace Types
// ============================================================================
// Based on Kode-cli skill marketplace design
// ============================================================================

import { z } from 'zod';

// ----------------------------------------------------------------------------
// Marketplace Source Types
// ----------------------------------------------------------------------------

export const MarketplaceSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    repo: z.string().min(3),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    source: z.literal('npm'),
    package: z.string().min(1),
  }),
  z.object({
    source: z.literal('directory'),
    path: z.string().min(1),
  }),
]);

export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

// ----------------------------------------------------------------------------
// Plugin Entry
// ----------------------------------------------------------------------------

export const PluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.string().default('./'),
  skills: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  author: z.string().optional(),
});

export type PluginEntry = z.infer<typeof PluginEntrySchema>;

// ----------------------------------------------------------------------------
// Marketplace Manifest
// ----------------------------------------------------------------------------

export const MarketplaceManifestSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  owner: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
  }).optional(),
  plugins: z.array(PluginEntrySchema).default([]),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

// ----------------------------------------------------------------------------
// Known Marketplaces Config
// ----------------------------------------------------------------------------

export const KnownMarketplaceEntrySchema = z.object({
  source: MarketplaceSourceSchema,
  installLocation: z.string().min(1),
  lastUpdated: z.string(),
  autoUpdate: z.boolean().optional(),
});

export type KnownMarketplaceEntry = z.infer<typeof KnownMarketplaceEntrySchema>;

export const KnownMarketplacesSchema = z.record(
  z.string(),
  KnownMarketplaceEntrySchema
);

export type KnownMarketplacesConfig = z.infer<typeof KnownMarketplacesSchema>;

// ----------------------------------------------------------------------------
// Plugin Scope
// ----------------------------------------------------------------------------

export type PluginScope = 'user' | 'project';

// ----------------------------------------------------------------------------
// Installed Plugin Record
// ----------------------------------------------------------------------------

export interface InstalledPluginRecord {
  /** Plugin name */
  plugin: string;
  /** Marketplace name */
  marketplace: string;
  /** Installation scope */
  scope: PluginScope;
  /** Is the plugin enabled */
  isEnabled: boolean;
  /** Project path (for project scope) */
  projectPath?: string;
  /** Installation timestamp */
  installedAt: string;
  /** Plugin root directory (for plugin-pack type) */
  pluginRoot?: string;
  /** Installed skill names */
  skills: string[];
  /** Installed command paths */
  commands: string[];
  /** Original marketplace source path */
  sourceMarketplacePath: string;
}

export type InstalledPluginsFile = Record<string, InstalledPluginRecord>;

// ----------------------------------------------------------------------------
// Installation Result
// ----------------------------------------------------------------------------

export interface InstallResult {
  pluginSpec: string;
  installedSkills: string[];
  installedCommands: string[];
}

export interface UninstallResult {
  pluginSpec: string;
  removedSkills: string[];
  removedCommands: string[];
}

// ----------------------------------------------------------------------------
// Marketplace Info (for IPC)
// ----------------------------------------------------------------------------

export interface MarketplaceInfo {
  /** Marketplace name (unique identifier) */
  name: string;
  /** Marketplace description */
  description?: string;
  /** Source configuration */
  source: MarketplaceSource;
  /** Installation location */
  installLocation: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** Number of plugins */
  pluginCount: number;
  /** Auto update enabled */
  autoUpdate?: boolean;
}

// ----------------------------------------------------------------------------
// Marketplace Plugin Entry (for IPC)
// ----------------------------------------------------------------------------

export interface MarketplacePluginEntry {
  /** Plugin name */
  name: string;
  /** Plugin description */
  description?: string;
  /** Marketplace name */
  marketplace: string;
  /** Plugin source path */
  source: string;
  /** Available skills */
  skills?: string[];
  /** Available commands */
  commands?: string[];
  /** Tags */
  tags?: string[];
  /** Version */
  version?: string;
  /** Author */
  author?: string;
  /** Is installed */
  isInstalled?: boolean;
  /** Is enabled (if installed) */
  isEnabled?: boolean;
}

// ----------------------------------------------------------------------------
// Installed Plugin (for IPC)
// ----------------------------------------------------------------------------

export interface InstalledPlugin {
  /** Plugin name */
  name: string;
  /** Marketplace name */
  marketplace: string;
  /** Installation scope */
  scope: PluginScope;
  /** Is enabled */
  isEnabled: boolean;
  /** Project path (for project scope) */
  projectPath?: string;
  /** Installed at timestamp */
  installedAt: string;
  /** Plugin root directory */
  pluginRoot?: string;
  /** Installed skills */
  skills: string[];
  /** Installed commands */
  commands: string[];
}

// ----------------------------------------------------------------------------
// Result Types (for IPC)
// ----------------------------------------------------------------------------

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
  error?: string;
}
