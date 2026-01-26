// ============================================================================
// Plugin Registry - Manage plugin lifecycle
// ============================================================================

import type { Tool } from '../tools/toolRegistry';
import { registerTool, unregisterTool } from '../tools/toolRegistry';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginStorage,
  PluginHookRegistration,
  RegisteredPluginHook,
  PluginHookContext,
  PluginHookResult,
} from './types';
import type { HookEvent } from '../hooks/events';
import { discoverPlugins, loadPlugin, watchPluginsDir } from './pluginLoader';
import { createPluginStorage, initPluginStorageTable } from './pluginStorage';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PluginRegistry');

// ----------------------------------------------------------------------------
// Plugin Registry Class
// ----------------------------------------------------------------------------

/**
 * Plugin Registry - 插件注册表
 *
 * 管理插件的完整生命周期：
 * - 发现：扫描插件目录
 * - 加载：解析 manifest 和入口文件
 * - 激活：调用 activate(api)
 * - 停用：调用 deactivate()
 *
 * 插件能力：
 * - 注册自定义工具（Tool）
 * - 访问本地存储
 * - 订阅事件
 *
 * @example
 * ```typescript
 * const registry = getPluginRegistry();
 * await registry.initialize();
 *
 * const plugins = registry.getPlugins();
 * await registry.enablePlugin('my-plugin');
 * ```
 *
 * @see PluginLoader - 插件加载器
 * @see PluginAPI - 插件 API 接口
 */
export class PluginRegistry {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private stopWatcher: (() => void) | null = null;

  // Hook management
  private registeredHooks: Map<string, RegisteredPluginHook> = new Map();
  private hookIdCounter: number = 0;

  /**
   * Get all registered plugins
   */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get a specific plugin by ID
   */
  getPlugin(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Initialize plugin system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing plugin system...');

    // Initialize storage table
    initPluginStorageTable();

    // Discover and load plugins
    const plugins = await discoverPlugins();
    for (const plugin of plugins) {
      this.plugins.set(plugin.manifest.id, plugin);
    }

    // Activate all plugins
    await this.activateAll();

    // Start watching for changes
    this.startWatching();

    logger.info(`Plugin system initialized. ${this.plugins.size} plugins loaded.`);
  }

  /**
   * Shutdown plugin system
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down plugin system...');

    // Stop watching
    if (this.stopWatcher) {
      this.stopWatcher();
      this.stopWatcher = null;
    }

    // Deactivate all plugins
    await this.deactivateAll();

    this.plugins.clear();
    logger.info('Plugin system shut down.');
  }

  /**
   * Create plugin API for a specific plugin
   */
  private createPluginAPI(plugin: LoadedPlugin): PluginAPI {
    const pluginTools: string[] = [];

    return {
      metadata: plugin.manifest,

      registerTool: (tool: Tool) => {
        // Prefix tool name with plugin ID to avoid conflicts
        const prefixedTool: Tool = {
          ...tool,
          name: `${plugin.manifest.id}:${tool.name}`,
        };
        registerTool(prefixedTool);
        pluginTools.push(prefixedTool.name);
        plugin.registeredTools.push(prefixedTool.name);
        logger.info(`Plugin ${plugin.manifest.id} registered tool: ${prefixedTool.name}`);
      },

      unregisterTool: (toolName: string) => {
        const prefixedName = `${plugin.manifest.id}:${toolName}`;
        unregisterTool(prefixedName);
        const idx = plugin.registeredTools.indexOf(prefixedName);
        if (idx !== -1) {
          plugin.registeredTools.splice(idx, 1);
        }
      },

      log: (level, message) => {
        const prefix = `[Plugin:${plugin.manifest.id}]`;
        switch (level) {
          case 'debug':
            console.debug(prefix, message);
            break;
          case 'info':
            console.log(prefix, message);
            break;
          case 'warn':
            console.warn(prefix, message);
            break;
          case 'error':
            console.error(prefix, message);
            break;
        }
      },

      getStorage: () => this.createPersistentStorage(plugin.manifest.id),

      showNotification: (title, body) => {
        // TODO: Implement notifications
        logger.info(`[Notification] ${title}: ${body}`);
      },

      registerHook: (registration: PluginHookRegistration) => {
        const hookId = registration.id || `${plugin.manifest.id}:hook:${++this.hookIdCounter}`;
        const hook: RegisteredPluginHook = {
          id: hookId,
          pluginId: plugin.manifest.id,
          event: registration.event,
          toolMatcher: registration.toolMatcher,
          handler: registration.handler,
          priority: registration.priority ?? 100,
        };
        this.registeredHooks.set(hookId, hook);
        plugin.registeredHooks.push(hookId);
        logger.info(`Plugin ${plugin.manifest.id} registered hook: ${hookId} for event ${registration.event}`);
      },

      unregisterHook: (hookId: string) => {
        this.registeredHooks.delete(hookId);
        const idx = plugin.registeredHooks.indexOf(hookId);
        if (idx !== -1) {
          plugin.registeredHooks.splice(idx, 1);
        }
        logger.debug(`Plugin ${plugin.manifest.id} unregistered hook: ${hookId}`);
      },
    };
  }

  /**
   * Create storage interface for a plugin
   * Uses SQLite for persistent storage
   */
  private createPersistentStorage(pluginId: string): PluginStorage {
    return createPluginStorage(pluginId);
  }

  /**
   * Activate a single plugin
   */
  async activatePlugin(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      logger.error(`Plugin not found: ${pluginId}`);
      return false;
    }

    if (plugin.state === 'active') {
      return true;
    }

    if (!plugin.entry) {
      plugin.state = 'error';
      plugin.error = 'Plugin has no entry module';
      return false;
    }

    try {
      plugin.state = 'activating';
      const api = this.createPluginAPI(plugin);
      await plugin.entry.activate(api);
      plugin.state = 'active';
      logger.info(`Plugin activated: ${pluginId}`);
      return true;
    } catch (err: any) {
      plugin.state = 'error';
      plugin.error = err.message;
      logger.error(`Failed to activate plugin ${pluginId}:`, err);
      return false;
    }
  }

  /**
   * Deactivate a single plugin
   */
  async deactivatePlugin(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    if (plugin.state !== 'active') {
      return true;
    }

    try {
      // Call deactivate hook if available
      if (plugin.entry?.deactivate) {
        await plugin.entry.deactivate();
      }

      // Unregister all tools
      for (const toolName of plugin.registeredTools) {
        unregisterTool(toolName);
      }
      plugin.registeredTools = [];

      // Unregister all hooks
      for (const hookId of plugin.registeredHooks) {
        this.registeredHooks.delete(hookId);
      }
      plugin.registeredHooks = [];

      plugin.state = 'inactive';
      logger.info(`Plugin deactivated: ${pluginId}`);
      return true;
    } catch (err: any) {
      plugin.state = 'error';
      plugin.error = err.message;
      logger.error(`Failed to deactivate plugin ${pluginId}:`, err);
      return false;
    }
  }

  /**
   * Activate all plugins
   */
  private async activateAll(): Promise<void> {
    for (const [pluginId] of this.plugins) {
      await this.activatePlugin(pluginId);
    }
  }

  /**
   * Deactivate all plugins
   */
  private async deactivateAll(): Promise<void> {
    for (const [pluginId] of this.plugins) {
      await this.deactivatePlugin(pluginId);
    }
  }

  /**
   * Start watching for plugin changes
   */
  private startWatching(): void {
    this.stopWatcher = watchPluginsDir(
      async (pluginDir) => {
        logger.info(`New plugin detected: ${pluginDir}`);
        const result = await loadPlugin(pluginDir);
        if (result.success && result.plugin) {
          this.plugins.set(result.plugin.manifest.id, result.plugin);
          await this.activatePlugin(result.plugin.manifest.id);
        }
      },
      async (pluginName) => {
        logger.info(`Plugin removed: ${pluginName}`);
        // Find and deactivate plugin
        for (const [id, plugin] of this.plugins) {
          if (plugin.rootPath.endsWith(pluginName)) {
            await this.deactivatePlugin(id);
            this.plugins.delete(id);
            break;
          }
        }
      }
    );
  }

  // --------------------------------------------------------------------------
  // Hook Execution Methods
  // --------------------------------------------------------------------------

  /**
   * Execute hooks for a specific event
   * Returns aggregated result from all matching hooks
   */
  async executeHooks(
    event: HookEvent,
    context: PluginHookContext
  ): Promise<PluginHookResult> {
    // Find all matching hooks
    const matchingHooks = Array.from(this.registeredHooks.values())
      .filter(hook => {
        if (hook.event !== event) return false;

        // For tool events, check tool matcher
        if (context.toolName && hook.toolMatcher) {
          if (hook.toolMatcher.startsWith('/') && hook.toolMatcher.endsWith('/')) {
            // Regex matcher
            const regex = new RegExp(hook.toolMatcher.slice(1, -1));
            return regex.test(context.toolName);
          }
          // Exact match or wildcard
          return hook.toolMatcher === '*' || hook.toolMatcher === context.toolName;
        }

        return true;
      })
      .sort((a, b) => a.priority - b.priority);

    if (matchingHooks.length === 0) {
      return { allow: true };
    }

    // Execute hooks in priority order
    let result: PluginHookResult = { allow: true };

    for (const hook of matchingHooks) {
      try {
        const hookResult = await hook.handler(context);

        // Merge results
        if (hookResult.allow === false) {
          result.allow = false;
          result.message = hookResult.message;
          // Stop on first block
          break;
        }

        if (hookResult.message) {
          result.message = (result.message || '') + '\n' + hookResult.message;
        }

        if (hookResult.modifiedInput) {
          result.modifiedInput = hookResult.modifiedInput;
          // Update context for next hook
          context.toolInput = hookResult.modifiedInput;
        }
      } catch (error) {
        logger.error(`Hook ${hook.id} execution failed:`, error);
        // Continue with next hook on error
      }
    }

    return result;
  }

  /**
   * Execute PreToolUse hooks
   */
  async executePreToolUseHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId: string,
    workingDirectory: string
  ): Promise<PluginHookResult> {
    return this.executeHooks('PreToolUse', {
      event: 'PreToolUse',
      toolName,
      toolInput,
      sessionId,
      workingDirectory,
      timestamp: Date.now(),
    });
  }

  /**
   * Execute PostToolUse hooks
   */
  async executePostToolUseHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    sessionId: string,
    workingDirectory: string
  ): Promise<void> {
    await this.executeHooks('PostToolUse', {
      event: 'PostToolUse',
      toolName,
      toolInput,
      toolOutput,
      sessionId,
      workingDirectory,
      timestamp: Date.now(),
    });
  }

  /**
   * Execute SessionStart hooks
   */
  async executeSessionStartHooks(
    sessionId: string,
    workingDirectory: string
  ): Promise<void> {
    await this.executeHooks('SessionStart', {
      event: 'SessionStart',
      sessionId,
      workingDirectory,
      timestamp: Date.now(),
    });
  }

  /**
   * Execute SessionEnd hooks
   */
  async executeSessionEndHooks(
    sessionId: string,
    workingDirectory: string
  ): Promise<void> {
    await this.executeHooks('SessionEnd', {
      event: 'SessionEnd',
      sessionId,
      workingDirectory,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all registered hooks for debugging
   */
  getRegisteredHooks(): RegisteredPluginHook[] {
    return Array.from(this.registeredHooks.values());
  }

  // --------------------------------------------------------------------------
  // Plugin Management Methods
  // --------------------------------------------------------------------------

  /**
   * Reload a plugin
   */
  async reloadPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    await this.deactivatePlugin(pluginId);

    const result = await loadPlugin(plugin.rootPath);
    if (result.success && result.plugin) {
      this.plugins.set(pluginId, result.plugin);
      return this.activatePlugin(pluginId);
    }

    return false;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

const pluginRegistry = new PluginRegistry();

export function getPluginRegistry(): PluginRegistry {
  return pluginRegistry;
}

export async function initPluginSystem(): Promise<void> {
  await pluginRegistry.initialize();
}

export async function shutdownPluginSystem(): Promise<void> {
  await pluginRegistry.shutdown();
}
