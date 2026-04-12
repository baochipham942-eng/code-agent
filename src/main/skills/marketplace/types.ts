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
// IPC Types (canonical definitions in shared/contract/marketplace.ts)
// Re-exported here for backward compatibility with main/ imports
// ----------------------------------------------------------------------------
export type {
  MarketplaceInfo,
  MarketplacePluginEntry,
  InstalledPlugin,
  MarketplaceResult,
  PluginInstallResult,
} from '../../../shared/contract/marketplace';
