// ============================================================================
// Plugin System Types
// ============================================================================

import type { Tool } from '../tools/toolRegistry';

/**
 * Plugin metadata from package.json or plugin.json
 */
export interface PluginMetadata {
  /** Unique plugin identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Plugin description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** Minimum app version required */
  minAppVersion?: string;
  /** Plugin homepage/repository URL */
  homepage?: string;
}

/**
 * Plugin manifest - defines what the plugin provides
 */
export interface PluginManifest extends PluginMetadata {
  /** Entry point file (relative to plugin root) */
  main: string;
  /** Generation compatibility */
  generations?: string[];
  /** Required permissions */
  permissions?: PluginPermission[];
  /** Plugin capabilities */
  capabilities?: PluginCapability[];
}

/**
 * Plugin permissions that must be granted
 */
export type PluginPermission =
  | 'filesystem'   // Access to file system
  | 'network'      // Access to network
  | 'shell'        // Execute shell commands
  | 'clipboard'    // Access clipboard
  | 'notification' // Show notifications
  | 'storage';     // Persistent storage

/**
 * Plugin capability types
 */
export type PluginCapability =
  | 'tools'        // Provides tools
  | 'skills'       // Provides skills
  | 'theme'        // Provides theme
  | 'language';    // Provides language support

/**
 * Plugin lifecycle hooks
 */
export interface PluginHooks {
  /** Called when plugin is activated */
  onActivate?: () => Promise<void>;
  /** Called when plugin is deactivated */
  onDeactivate?: () => Promise<void>;
  /** Called when settings change */
  onSettingsChange?: (settings: Record<string, unknown>) => Promise<void>;
}

/**
 * Plugin API provided to plugins
 */
export interface PluginAPI {
  /** Plugin's own metadata */
  metadata: PluginMetadata;
  /** Register a tool */
  registerTool: (tool: Tool) => void;
  /** Unregister a tool */
  unregisterTool: (toolName: string) => void;
  /** Log message */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Get plugin storage */
  getStorage: () => PluginStorage;
  /** Show notification */
  showNotification?: (title: string, body: string) => void;
}

/**
 * Plugin storage interface
 */
export interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Plugin entry point interface - what plugins must export
 */
export interface PluginEntry {
  /** Plugin activation function */
  activate: (api: PluginAPI) => Promise<void>;
  /** Plugin deactivation function */
  deactivate?: () => Promise<void>;
}

/**
 * Plugin state in the registry
 */
export type PluginState = 'inactive' | 'activating' | 'active' | 'error' | 'disabled';

/**
 * Loaded plugin instance
 */
export interface LoadedPlugin {
  /** Plugin manifest */
  manifest: PluginManifest;
  /** Plugin root directory */
  rootPath: string;
  /** Plugin state */
  state: PluginState;
  /** Error message if state is 'error' */
  error?: string;
  /** Plugin entry module */
  entry?: PluginEntry;
  /** Tools registered by this plugin */
  registeredTools: string[];
}

/**
 * Plugin load result
 */
export interface PluginLoadResult {
  success: boolean;
  plugin?: LoadedPlugin;
  error?: string;
}
