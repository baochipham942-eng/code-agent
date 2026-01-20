// ============================================================================
// Plugin Registry - Manage plugin lifecycle
// ============================================================================

import type { Tool } from '../tools/toolRegistry';
import { registerTool, unregisterTool } from '../tools/toolRegistry';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginStorage,
  PluginState,
} from './types';
import { discoverPlugins, loadPlugin, watchPluginsDir } from './pluginLoader';

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
class PluginRegistry {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private stopWatcher: (() => void) | null = null;

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
    console.log('Initializing plugin system...');

    // Discover and load plugins
    const plugins = await discoverPlugins();
    for (const plugin of plugins) {
      this.plugins.set(plugin.manifest.id, plugin);
    }

    // Activate all plugins
    await this.activateAll();

    // Start watching for changes
    this.startWatching();

    console.log(`Plugin system initialized. ${this.plugins.size} plugins loaded.`);
  }

  /**
   * Shutdown plugin system
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down plugin system...');

    // Stop watching
    if (this.stopWatcher) {
      this.stopWatcher();
      this.stopWatcher = null;
    }

    // Deactivate all plugins
    await this.deactivateAll();

    this.plugins.clear();
    console.log('Plugin system shut down.');
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
        console.log(`Plugin ${plugin.manifest.id} registered tool: ${prefixedTool.name}`);
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

      getStorage: () => this.createPluginStorage(plugin.manifest.id),

      showNotification: (title, body) => {
        // TODO: Implement notifications
        console.log(`[Notification] ${title}: ${body}`);
      },
    };
  }

  /**
   * Create storage interface for a plugin
   */
  private createPluginStorage(pluginId: string): PluginStorage {
    const storageKey = `plugin:${pluginId}:`;

    // Simple in-memory storage for now
    // TODO: Implement persistent storage with sqlite
    const storage = new Map<string, unknown>();

    return {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.get(storageKey + key) as T | undefined;
      },

      async set<T>(key: string, value: T): Promise<void> {
        storage.set(storageKey + key, value);
      },

      async delete(key: string): Promise<void> {
        storage.delete(storageKey + key);
      },

      async clear(): Promise<void> {
        for (const key of storage.keys()) {
          if (key.startsWith(storageKey)) {
            storage.delete(key);
          }
        }
      },
    };
  }

  /**
   * Activate a single plugin
   */
  async activatePlugin(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      console.error(`Plugin not found: ${pluginId}`);
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
      console.log(`Plugin activated: ${pluginId}`);
      return true;
    } catch (err: any) {
      plugin.state = 'error';
      plugin.error = err.message;
      console.error(`Failed to activate plugin ${pluginId}:`, err);
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

      plugin.state = 'inactive';
      console.log(`Plugin deactivated: ${pluginId}`);
      return true;
    } catch (err: any) {
      plugin.state = 'error';
      plugin.error = err.message;
      console.error(`Failed to deactivate plugin ${pluginId}:`, err);
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
        console.log(`New plugin detected: ${pluginDir}`);
        const result = await loadPlugin(pluginDir);
        if (result.success && result.plugin) {
          this.plugins.set(result.plugin.manifest.id, result.plugin);
          await this.activatePlugin(result.plugin.manifest.id);
        }
      },
      async (pluginName) => {
        console.log(`Plugin removed: ${pluginName}`);
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
