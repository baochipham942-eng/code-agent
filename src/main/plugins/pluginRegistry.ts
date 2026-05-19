// ============================================================================
// Plugin Registry - Manage plugin lifecycle
// ============================================================================

import type { Tool } from '../tools/types';
import { getProtocolRegistry } from '../tools/protocolRegistry';
import { wrapLegacyTool } from '../tools/modules/_helpers/legacyAdapter';
import type { ToolCategory, ToolModule } from '../protocol/tools';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginStorage,
  PluginHookRegistration,
  RegisteredPluginHook,
  PluginHookContext,
  PluginHookResult,
  PluginApiKeyProvider,
  PluginConstantsNamespace,
  PluginRegisterToolModuleOptions,
} from './types';
import type { HookEvent } from '../protocol/events';
import type { ModelProvider } from '../../shared/contract';
import { discoverPlugins, loadPlugin, watchPluginsDir } from './pluginLoader';
import { createPluginStorage, initPluginStorageTable } from './pluginStorage';
// Builtin plugins — 与 host 同 bundle，通过静态 import 让 esbuild 打包，不走磁盘 discovery
import {
  manifest as builtinImageProcessManifest,
  default as builtinImageProcessEntry,
} from './builtin/imageProcess';
import {
  manifest as builtinAudioProcessingManifest,
  default as builtinAudioProcessingEntry,
} from './builtin/audioProcessing';
import {
  manifest as builtinVideoGenerationManifest,
  default as builtinVideoGenerationEntry,
} from './builtin/videoGeneration';
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';
import { getAuthService } from '../services/auth/authService';
import {
  // models
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  MODEL_MAX_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOWS,
  // providers
  MODEL_API_ENDPOINTS,
  // pricing
  MODEL_PRICING_PER_1M,
  // timeouts
  MCP_TIMEOUTS,
  DAG_SCHEDULER,
  AGENT_TIMEOUTS,
  NETWORK_TOOL_TIMEOUTS,
  BROWSER_TIMEOUTS,
} from '../../shared/constants';

const logger = createLogger('PluginRegistry');

// ----------------------------------------------------------------------------
// PluginAPI v2 — 静态白名单与常量投影
// ----------------------------------------------------------------------------

/**
 * Provider 白名单的运行时拷贝。TS 类型擦除后插件可能传任意字符串，
 * 用 Set 做二次校验。新增 provider 时必须同步更新 PluginApiKeyProvider 类型。
 */
const ALLOWED_PROVIDERS: ReadonlySet<PluginApiKeyProvider> = new Set<PluginApiKeyProvider>([
  'deepseek', 'claude', 'openai', 'gemini', 'groq',
  'zhipu', 'qwen', 'moonshot', 'minimax', 'perplexity',
  'grok', 'openrouter', 'volcengine', 'longcat', 'xiaomi',
]);

/**
 * 面向插件的 provider endpoint 投影。
 *
 * 过滤规则：
 * - 移除 `zhipu`（0ki 代理订阅，内部链路）
 * - 移除 `zhipuCoding`（0ki Coding 套餐代理，内部链路）
 * - 移除 `kimiK25`（Kimi K2.5 Coding 套餐订阅特化端点，内部）
 * - 保留 `zhipuOfficial`（智谱官方公开 API，作为 zhipu 公开入口）
 * - 其余均为面向第三方的公开端点
 */
const PROVIDERS_PUBLIC_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  deepseek: MODEL_API_ENDPOINTS.deepseek,
  claude: MODEL_API_ENDPOINTS.claude,
  openai: MODEL_API_ENDPOINTS.openai,
  groq: MODEL_API_ENDPOINTS.groq,
  zhipuOfficial: MODEL_API_ENDPOINTS.zhipuOfficial,
  qwen: MODEL_API_ENDPOINTS.qwen,
  moonshot: MODEL_API_ENDPOINTS.moonshot,
  minimax: MODEL_API_ENDPOINTS.minimax,
  perplexity: MODEL_API_ENDPOINTS.perplexity,
  grok: MODEL_API_ENDPOINTS.grok,
  openrouter: MODEL_API_ENDPOINTS.openrouter,
  gemini: MODEL_API_ENDPOINTS.gemini,
  volcengine: MODEL_API_ENDPOINTS.volcengine,
  longcat: MODEL_API_ENDPOINTS.longcat,
  longcatClaude: MODEL_API_ENDPOINTS.longcatClaude,
  xiaomi: MODEL_API_ENDPOINTS.xiaomi,
  custom: MODEL_API_ENDPOINTS.custom,
  ollama: MODEL_API_ENDPOINTS.ollama,
});

/**
 * 按 namespace 提前 freeze，避免每次 createPluginAPI 都重建。
 * 插件拿到的是 Readonly 投影，无法回写宿主常量。
 */
const CONSTANTS_BUCKETS: Readonly<Record<PluginConstantsNamespace, Readonly<Record<string, unknown>>>> = Object.freeze({
  models: Object.freeze({
    DEFAULT_MODEL,
    DEFAULT_MODELS,
    MODEL_MAX_TOKENS,
    MODEL_MAX_OUTPUT_TOKENS,
    CONTEXT_WINDOWS,
  }),
  providers: PROVIDERS_PUBLIC_ENDPOINTS,
  pricing: Object.freeze({
    MODEL_PRICING_PER_1M,
  }),
  timeouts: Object.freeze({
    MCP_TIMEOUTS,
    DAG_SCHEDULER,
    AGENT_TIMEOUTS,
    NETWORK_TOOL_TIMEOUTS,
    BROWSER_TIMEOUTS,
  }),
});

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

    // Load builtin plugins first（硬编码列表，与 host 同 bundle，不走磁盘 discovery）
    this.loadBuiltinPlugins();

    // Discover and load third-party plugins from disk
    const plugins = await discoverPlugins();
    for (const plugin of plugins) {
      this.plugins.set(plugin.manifest.id, plugin);
    }

    // Activate all plugins (builtin + third-party)
    await this.activateAll();

    // Start watching for changes
    this.startWatching();

    logger.info(`Plugin system initialized. ${this.plugins.size} plugins loaded.`);
  }

  /**
   * 加载 builtin plugins（与 host 同 bundle，硬编码列表）。
   *
   * 与磁盘 discovery 的区别：
   * - 不读 manifest.json / package.json，manifest 通过静态 import 拿到
   * - 不走 dynamic import，让 esbuild 能 tree-shake / 打包成 host 同一份代码
   * - rootPath 用占位符 `builtin:<id>`，watcher 和 reloadPlugin 都不会误命中
   *
   * 新增 builtin plugin 时在下方数组追加一条即可。
   */
  private loadBuiltinPlugins(): void {
    const builtinPlugins: Array<{
      manifest: import('./types').PluginManifest;
      entry: import('./types').PluginEntry;
    }> = [
      {
        manifest: builtinImageProcessManifest,
        entry: builtinImageProcessEntry,
      },
      {
        manifest: builtinAudioProcessingManifest,
        entry: builtinAudioProcessingEntry,
      },
      {
        manifest: builtinVideoGenerationManifest,
        entry: builtinVideoGenerationEntry,
      },
    ];

    for (const { manifest, entry } of builtinPlugins) {
      const loadedPlugin: LoadedPlugin = {
        manifest,
        rootPath: `builtin:${manifest.id}`,
        state: 'inactive',
        entry,
        registeredTools: [],
        registeredHooks: [],
      };
      this.plugins.set(manifest.id, loadedPlugin);
      logger.info(`Loaded builtin plugin: ${manifest.id}`);
    }
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
        const category = 'file' as ToolCategory;
        const wrapped = wrapLegacyTool(prefixedTool, {
          category,
          permissionLevel: prefixedTool.permissionLevel,
        });
        getProtocolRegistry().register(wrapped.schema, async () => wrapped);
        pluginTools.push(prefixedTool.name);
        plugin.registeredTools.push(prefixedTool.name);
        logger.info(`Plugin ${plugin.manifest.id} registered tool: ${prefixedTool.name}`);
      },

      unregisterTool: (toolName: string) => {
        const prefixedName = `${plugin.manifest.id}:${toolName}`;
        getProtocolRegistry().unregister(prefixedName);
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

      // ----------------------------------------------------------------------
      // PluginAPI v2
      // ----------------------------------------------------------------------

      pluginApiVersion: 2 as const,

      getApiKey: async (provider: PluginApiKeyProvider) => {
        // 运行时白名单校验：TS 类型擦除后插件仍可能传任意字符串
        if (!ALLOWED_PROVIDERS.has(provider)) {
          logger.warn(`Plugin ${plugin.manifest.id} queried disallowed provider: ${provider}`);
          return undefined;
        }
        // configService.getApiKey 是同步签名，这里用 async 函数自动包装成 Promise，
        // 给将来的远程 vault 实现留空间（届时只需改本函数实现，签名不变）。
        return getConfigService().getApiKey(provider as ModelProvider);
      },

      getCurrentUser: () => {
        const auth = getAuthService();
        const user = auth.getCurrentUser();
        if (!user) return null;
        // admin trust-gate：未经服务端验证的 cached session 强制 isAdmin: false，
        // 与 authService.getPublicUserForCurrentTrust 的策略保持一致。
        const hasVerified = auth.hasVerifiedSession();
        return {
          id: user.id,
          isAdmin: hasVerified ? (user.isAdmin ?? false) : false,
        };
      },

      getConstants: (namespace: PluginConstantsNamespace) => {
        return CONSTANTS_BUCKETS[namespace];
      },

      registerToolModule: (
        module: ToolModule,
        options?: PluginRegisterToolModuleOptions,
      ) => {
        // 默认 prefixWithPluginId=true，与既有第三方插件安全模型一致。
        // 传 false 仅供 builtin plugin 使用：保留原工具名，避免破坏 executionPhase
        // 分类、ToolSearch deferredTools 注册、LLM prompt / cache / eval baseline。
        const prefixWithPluginId = options?.prefixWithPluginId ?? true;
        const finalName = prefixWithPluginId
          ? `${plugin.manifest.id}:${module.schema.name}`
          : module.schema.name;
        const finalModule: ToolModule = {
          schema: {
            ...module.schema,
            name: finalName,
          },
          createHandler: module.createHandler.bind(module),
        };
        // 双通道命名冲突检查（registerTool + registerToolModule 共享 registeredTools）。
        // opt-out 也走这条检查 — builtin plugin 之间或与第三方插件撞名时仍要抛错。
        if (plugin.registeredTools.includes(finalName)) {
          throw new Error(`Tool ${finalName} already registered`);
        }
        // ToolLoader 签名要求返回 Promise<ToolModule>，registry 内部首次解析时再调 createHandler
        getProtocolRegistry().register(finalModule.schema, async () => finalModule);
        plugin.registeredTools.push(finalName);
        logger.info(`Plugin ${plugin.manifest.id} registered tool module: ${finalName}`);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      plugin.state = 'error';
      plugin.error = message;
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
        getProtocolRegistry().unregister(toolName);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      plugin.state = 'error';
      plugin.error = message;
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
   * Start watching for plugin changes (hot-reload)
   *
   * Handles three scenarios:
   * 1. New plugin added → load + activate
   * 2. Plugin removed → deactivate + unregister
   * 3. Existing plugin modified → deactivate + reload + re-activate (hot-reload)
   */
  private startWatching(): void {
    // Debounce map to prevent rapid-fire reloads
    const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 500;

    this.stopWatcher = watchPluginsDir(
      async (pluginDir) => {
        // Check if this is an existing plugin being modified (hot-reload)
        const existingPlugin = this.findPluginByPath(pluginDir);
        if (existingPlugin) {
          // Debounce: file systems fire multiple events for a single save
          const existing = reloadTimers.get(existingPlugin.manifest.id);
          if (existing) clearTimeout(existing);

          reloadTimers.set(existingPlugin.manifest.id, setTimeout(async () => {
            reloadTimers.delete(existingPlugin.manifest.id);
            logger.info(`Hot-reloading plugin: ${existingPlugin.manifest.id}`);
            const reloaded = await this.reloadPlugin(existingPlugin.manifest.id);
            if (reloaded) {
              logger.info(`Plugin hot-reloaded successfully: ${existingPlugin.manifest.id}`);
            } else {
              logger.warn(`Plugin hot-reload failed: ${existingPlugin.manifest.id}`);
            }
          }, DEBOUNCE_MS));
          return;
        }

        // New plugin added
        logger.info(`New plugin detected: ${pluginDir}`);
        const result = await loadPlugin(pluginDir);
        if (result.success && result.plugin) {
          this.plugins.set(result.plugin.manifest.id, result.plugin);
          await this.activatePlugin(result.plugin.manifest.id);
          logger.info(`New plugin activated: ${result.plugin.manifest.id}`);
        }
      },
      async (pluginName) => {
        logger.info(`Plugin removed: ${pluginName}`);
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
   * Find a plugin by its root path.
   */
  private findPluginByPath(pluginDir: string): LoadedPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.rootPath === pluginDir) return plugin;
    }
    return undefined;
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
    const result: PluginHookResult = { allow: true };

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
   *
   * Builtin plugin（rootPath 以 `builtin:` 开头）跳过磁盘 reload — 它跟 host
   * 同 bundle，没有独立磁盘路径可走 dynamic import。这类插件只走 deactivate +
   * activate（用静态 import 留下的 entry 引用）。
   */
  async reloadPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    await this.deactivatePlugin(pluginId);

    // Builtin plugin: 没有磁盘路径，直接复用现有 entry 重新 activate
    if (plugin.rootPath.startsWith('builtin:')) {
      return this.activatePlugin(pluginId);
    }

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
