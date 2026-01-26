// ============================================================================
// Plugin System Types
// ============================================================================

import type { Tool } from '../tools/toolRegistry';
import type { HookEvent } from '../hooks/events';

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
  /** Register an event hook */
  registerHook: (registration: PluginHookRegistration) => void;
  /** Unregister an event hook */
  unregisterHook: (hookId: string) => void;
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
  /** Hooks registered by this plugin */
  registeredHooks: string[];
}

/**
 * Plugin load result
 */
export interface PluginLoadResult {
  success: boolean;
  plugin?: LoadedPlugin;
  error?: string;
}

// ----------------------------------------------------------------------------
// Plugin Event Hook Types (HookManager Integration)
// ----------------------------------------------------------------------------

/**
 * Plugin hook registration - register hooks with HookManager
 */
export interface PluginHookRegistration {
  /** Unique hook ID (auto-generated if not provided) */
  id?: string;
  /** Event type to listen for */
  event: HookEvent;
  /** Tool name matcher for tool events (regex string or exact match) */
  toolMatcher?: string;
  /** Hook handler function */
  handler: PluginHookHandler;
  /** Priority (lower = earlier, default: 100) */
  priority?: number;
}

/**
 * Plugin hook handler function
 */
export type PluginHookHandler = (context: PluginHookContext) => Promise<PluginHookResult>;

/**
 * Context passed to plugin hook handlers
 */
export interface PluginHookContext {
  /** Event type */
  event: HookEvent;
  /** Session ID */
  sessionId: string;
  /** Working directory */
  workingDirectory: string;
  /** Timestamp */
  timestamp: number;
  /** Tool name (for tool events) */
  toolName?: string;
  /** Tool input as object (for tool events) */
  toolInput?: Record<string, unknown>;
  /** Tool output (for PostToolUse) */
  toolOutput?: string;
  /** Error message (for failure events) */
  errorMessage?: string;
  /** User prompt (for UserPromptSubmit) */
  prompt?: string;
}

/**
 * Result returned by plugin hook handlers
 */
export interface PluginHookResult {
  /** Whether to allow the action to proceed */
  allow?: boolean;
  /** Message to inject into context */
  message?: string;
  /** Modified tool input (for PreToolUse) */
  modifiedInput?: Record<string, unknown>;
}

/**
 * Internal hook registration record
 */
export interface RegisteredPluginHook {
  /** Hook ID */
  id: string;
  /** Plugin ID */
  pluginId: string;
  /** Event type */
  event: HookEvent;
  /** Tool matcher */
  toolMatcher?: string;
  /** Handler function */
  handler: PluginHookHandler;
  /** Priority */
  priority: number;
}
