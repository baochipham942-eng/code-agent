// ============================================================================
// Plugin Registry - Manage plugin lifecycle
// ============================================================================

import path from 'node:path';
import type { Tool } from '../tools/types';
import { wrapLegacyTool } from '../tools/modules/_helpers/legacyAdapter';
import { registerProtocolTool, unregisterProtocolTool } from '../tools/protocolToolRegistration';
import type { ToolCategory, ToolModule } from '../protocol/tools';
import type {
  LoadedPlugin,
  PluginManifest,
  PluginAPI,
  PluginPermission,
  PluginStorage,
  PluginApiKeyProvider,
  PluginConstantsNamespace,
  PluginRegisterToolModuleOptions,
} from './types';
import type { ModelProvider } from '../../shared/contract';
import { discoverPlugins, loadPlugin, watchPluginsDir } from './pluginLoader';
import {
  normalizePluginCapabilityDeclaration,
  PluginCapabilitySurface,
} from './pluginCapabilitySurface';
import { createPluginStorage, initPluginStorageTable } from './pluginStorage';
import {
  isBuiltinCapabilityInstalledSync,
  migrateLegacyComputerUseEnv,
} from './builtin/computerUse/installState';
import { BUILTIN_PLUGIN_CATALOG, findBuiltinPlugin } from './builtin/catalog';
import { recordCapabilityPackageLifecycle } from '../services/capabilities/capabilityPackageLifecycle';
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
  PRICING_TABLE_VERSION,
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
    PRICING_TABLE_VERSION,
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
  private readonly capabilitySurface = new PluginCapabilitySurface();

  constructor(
    private readonly watchPlugins: typeof watchPluginsDir = watchPluginsDir,
    private readonly recordLifecycle: typeof recordCapabilityPackageLifecycle = recordCapabilityPackageLifecycle,
  ) {}

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

  validatePluginCapabilityManifest(manifest: PluginManifest): void {
    this.capabilitySurface.validateCandidate(manifest);
  }

  private assertPermission(plugin: LoadedPlugin, permission: PluginPermission, operation: string): void {
    if (plugin.rootPath.startsWith('builtin:')) return;
    if (!plugin.manifest.permissions?.includes(permission)) {
      throw new Error(`能力包 ${plugin.manifest.id} 在${operation}前必须声明 '${permission}' 权限`);
    }
  }

  private assertLegacyToolPermission(plugin: LoadedPlugin, tool: Tool): void {
    if (tool.permissionLevel === 'write') this.assertPermission(plugin, 'filesystem', `注册工具 ${tool.name}`);
    if (tool.permissionLevel === 'execute') {
      this.assertPermission(plugin, 'shell', `注册工具 ${tool.name}`);
    }
    if (tool.permissionLevel === 'network') this.assertPermission(plugin, 'network', `注册工具 ${tool.name}`);
  }

  private assertToolModulePermission(plugin: LoadedPlugin, module: ToolModule): void {
    if (module.schema.category === 'fs') this.assertPermission(plugin, 'filesystem', `注册工具 ${module.schema.name}`);
    if (module.schema.category === 'shell') this.assertPermission(plugin, 'shell', `注册工具 ${module.schema.name}`);
    if (module.schema.category === 'network') this.assertPermission(plugin, 'network', `注册工具 ${module.schema.name}`);
  }

  /**
   * Initialize plugin system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing plugin system...');

    // Initialize storage table
    initPluginStorageTable();

    // Load builtin plugins first（硬编码列表，与 host 同 bundle，不走磁盘 discovery）
    await this.loadBuiltinPlugins();

    // Discover and load third-party plugins from disk
    const plugins = await discoverPlugins((pluginDir, error) => {
      this.recordLifecycle(path.basename(pluginDir), 'failed', `source=startup; ${error}`);
    });
    for (const plugin of plugins) {
      const existing = this.plugins.get(plugin.manifest.id);
      if (existing?.rootPath.startsWith('builtin:')) {
        const detail = 'source=startup; 能力包 ID 与内置能力冲突';
        plugin.state = 'error';
        plugin.error = detail;
        this.recordLifecycle(plugin.manifest.id, 'failed', detail);
        continue;
      }
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
  private async loadBuiltinPlugins(): Promise<void> {
    try {
      await migrateLegacyComputerUseEnv();
    } catch (error) {
      logger.warn('Failed to persist legacy Computer Use migration; keeping runtime compatibility', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const { manifest, entry } of BUILTIN_PLUGIN_CATALOG) {
      if (!isBuiltinCapabilityInstalledSync(manifest.id)) continue;
      const loadedPlugin: LoadedPlugin = {
        manifest,
        rootPath: `builtin:${manifest.id}`,
        state: 'inactive',
        entry,
        registeredTools: [],
      };
      this.plugins.set(manifest.id, loadedPlugin);
      logger.info(`Loaded builtin plugin: ${manifest.id}`);
    }
  }

  async installBuiltinCapability(pluginId: string): Promise<boolean> {
    const descriptor = findBuiltinPlugin(pluginId);
    if (!descriptor) return false;
    const existing = this.plugins.get(pluginId);
    if (existing) return this.activatePlugin(pluginId);

    const plugin: LoadedPlugin = {
      manifest: descriptor.manifest,
      rootPath: `builtin:${pluginId}`,
      state: 'inactive',
      entry: descriptor.entry,
      registeredTools: [],
    };
    this.plugins.set(pluginId, plugin);
    if (await this.activatePlugin(pluginId)) return true;
    this.plugins.delete(pluginId);
    return false;
  }

  async removeBuiltinCapability(pluginId: string): Promise<boolean> {
    if (!findBuiltinPlugin(pluginId)) return false;
    const plugin = this.plugins.get(pluginId);
    if (plugin?.rootPath !== `builtin:${pluginId}`) return false;
    if (!await this.deactivatePlugin(pluginId)) return false;
    this.plugins.delete(pluginId);
    return true;
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
        this.assertLegacyToolPermission(plugin, tool);
        // Prefix tool name with plugin ID to avoid conflicts
        const prefixedTool: Tool = {
          ...tool,
          name: `${plugin.manifest.id}:${tool.name}`,
        };
        // 双通道命名冲突检查(与 registerToolModule 对称)。底层 ToolRegistry
        // 是幂等覆盖,但 plugin 层把"重复注册"视为编程错误,而不是热重载入口 ——
        // 热重载走 reloadPlugin → deactivate(清空 registeredTools)→ activate,
        // 不依赖 silent overwrite。
        if (plugin.registeredTools.includes(prefixedTool.name)) {
          throw new Error(`Tool ${prefixedTool.name} already registered`);
        }
        const category = 'file' as ToolCategory;
        const wrapped = wrapLegacyTool(prefixedTool, {
          category,
          permissionLevel: prefixedTool.permissionLevel,
        });
        registerProtocolTool(wrapped.schema, async () => wrapped);
        pluginTools.push(prefixedTool.name);
        plugin.registeredTools.push(prefixedTool.name);
        logger.info(`Plugin ${plugin.manifest.id} registered tool: ${prefixedTool.name}`);
      },

      unregisterTool: (toolName: string) => {
        const prefixedName = `${plugin.manifest.id}:${toolName}`;
        unregisterProtocolTool(prefixedName);
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

      getStorage: () => {
        this.assertPermission(plugin, 'storage', '访问插件存储');
        return this.createPersistentStorage(plugin.manifest.id);
      },

      showNotification: (title, body) => {
        this.assertPermission(plugin, 'notification', '发送系统通知');
        // TODO: Implement notifications
        logger.info(`[Notification] ${title}: ${body}`);
      },

      // ----------------------------------------------------------------------
      // PluginAPI v2
      // ----------------------------------------------------------------------

      pluginApiVersion: 2 as const,

      getApiKey: async (provider: PluginApiKeyProvider) => {
        this.assertPermission(plugin, 'network', '读取服务凭据');
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
        this.assertToolModulePermission(plugin, module);
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
        registerProtocolTool(finalModule.schema, async () => finalModule);
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

    try {
      await this.capabilitySurface.load(
        plugin.manifest,
        () => this.activatePluginEntry(plugin),
        () => this.deactivatePluginEntry(plugin),
      );
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

    if (plugin.state !== 'active' && !this.capabilitySurface.isLoaded(pluginId)) {
      return true;
    }

    try {
      if (this.capabilitySurface.isLoaded(pluginId)) {
        await this.capabilitySurface.unload(pluginId);
      } else {
        await this.deactivatePluginEntry(plugin);
      }
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      plugin.state = this.capabilitySurface.isLoaded(pluginId) ? 'active' : 'error';
      plugin.error = message;
      logger.error(`Failed to deactivate plugin ${pluginId}:`, err);
      return false;
    }
  }

  /**
   * Activate all plugins
   */
  private async activateAll(): Promise<void> {
    const available = new Set<string>();
    for (const manifest of this.capabilitySurface.getActiveManifests()) {
      for (const key of manifest.provides ?? []) available.add(key);
    }
    const pending = new Map(
      [...this.plugins.values()]
        .filter((plugin) => plugin.state !== 'active')
        .map((plugin) => [plugin.manifest.id, plugin]),
    );

    while (pending.size > 0) {
      let progressed = false;
      for (const [pluginId, plugin] of pending) {
        const manifest = normalizePluginCapabilityDeclaration(plugin.manifest);
        if (!manifest.depends?.every((key) => available.has(key))) continue;
        pending.delete(pluginId);
        progressed = true;
        if (await this.activatePlugin(pluginId)) {
          for (const key of manifest.provides ?? []) available.add(key);
        } else {
          this.recordLifecycle(
            pluginId,
            'failed',
            `source=startup; ${plugin.error ?? 'activation failed'}`,
          );
        }
      }
      if (progressed) continue;

      const manifests = [...pending.values()].map((plugin) => (
        normalizePluginCapabilityDeclaration(plugin.manifest)
      ));
      const declaredProviders = new Set<string>(available);
      for (const manifest of manifests) {
        for (const key of manifest.provides ?? []) declaredProviders.add(key);
      }
      let removedMissing = false;
      for (const [pluginId, plugin] of pending) {
        const manifest = normalizePluginCapabilityDeclaration(plugin.manifest);
        const missing = (manifest.depends ?? []).filter((key) => !declaredProviders.has(key));
        if (missing.length === 0) continue;
        const detail = `plugin:${pluginId} is missing dependencies: ${missing.join(', ')}`;
        plugin.state = 'error';
        plugin.error = detail;
        this.recordLifecycle(pluginId, 'failed', `source=startup; ${detail}`);
        logger.warn(`Plugin skipped because dependencies cannot be satisfied: ${pluginId}`, { detail });
        pending.delete(pluginId);
        removedMissing = true;
      }
      if (removedMissing) continue;

      let detail = 'capability dependencies cannot be satisfied';
      try {
        this.capabilitySurface.validateGraph([
          ...this.capabilitySurface.getActiveManifests(),
          ...manifests,
        ]);
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      for (const [pluginId, plugin] of pending) {
        plugin.state = 'error';
        plugin.error = detail;
        this.recordLifecycle(pluginId, 'failed', `source=startup; ${detail}`);
        logger.warn(`Plugin skipped because dependencies cannot be satisfied: ${pluginId}`, { detail });
      }
      pending.clear();
    }
  }

  /**
   * Deactivate all plugins
   */
  private async deactivateAll(): Promise<void> {
    const ordered = this.capabilitySurface.getLoadedPluginIds().reverse();
    const remaining = [...this.plugins.keys()].filter((pluginId) => !ordered.includes(pluginId));
    for (const pluginId of [...ordered, ...remaining]) {
      await this.deactivatePlugin(pluginId);
    }
  }

  private async activatePluginEntry(plugin: LoadedPlugin): Promise<void> {
    if (!plugin.entry) throw new Error('Plugin has no entry module');
    try {
      plugin.state = 'activating';
      const api = this.createPluginAPI(plugin);
      await plugin.entry.activate(api);
      plugin.state = 'active';
      delete plugin.error;
      logger.info(`Plugin activated: ${plugin.manifest.id}`);
    } catch (error) {
      for (const toolName of plugin.registeredTools) unregisterProtocolTool(toolName);
      plugin.registeredTools = [];
      plugin.state = 'error';
      plugin.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async deactivatePluginEntry(plugin: LoadedPlugin): Promise<void> {
    if (plugin.entry?.deactivate) await plugin.entry.deactivate();
    for (const toolName of plugin.registeredTools) unregisterProtocolTool(toolName);
    plugin.registeredTools = [];
    plugin.state = 'inactive';
    delete plugin.error;
    logger.info(`Plugin deactivated: ${plugin.manifest.id}`);
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

    this.stopWatcher = this.watchPlugins(
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
              this.recordLifecycle(
                existingPlugin.manifest.id,
                'loaded',
                `source=watcher; event=reload; version=${this.plugins.get(existingPlugin.manifest.id)?.manifest.version ?? 'unknown'}`,
              );
              logger.info(`Plugin hot-reloaded successfully: ${existingPlugin.manifest.id}`);
            } else {
              this.recordLifecycle(existingPlugin.manifest.id, 'failed', 'source=watcher; event=reload');
              logger.warn(`Plugin hot-reload failed: ${existingPlugin.manifest.id}`);
            }
          }, DEBOUNCE_MS));
          return;
        }

        // New plugin added
        logger.info(`New plugin detected: ${pluginDir}`);
        const result = await loadPlugin(pluginDir);
        if (result.success && result.plugin) {
          const colliding = this.plugins.get(result.plugin.manifest.id);
          if (colliding?.rootPath.startsWith('builtin:')) {
            this.recordLifecycle(
              result.plugin.manifest.id,
              'failed',
              'source=watcher; event=add; 能力包 ID 与内置能力冲突',
            );
            return;
          }
          this.plugins.set(result.plugin.manifest.id, result.plugin);
          if (await this.activatePlugin(result.plugin.manifest.id)) {
            this.recordLifecycle(
              result.plugin.manifest.id,
              'loaded',
              `source=watcher; event=add; version=${result.plugin.manifest.version}`,
            );
            logger.info(`New plugin activated: ${result.plugin.manifest.id}`);
          } else {
            this.recordLifecycle(result.plugin.manifest.id, 'failed', 'source=watcher; event=add; activation failed');
          }
        } else {
          this.recordLifecycle(path.basename(pluginDir), 'failed', `source=watcher; event=add; ${result.error ?? 'load failed'}`);
        }
      },
      async (pluginName) => {
        logger.info(`Plugin removed: ${pluginName}`);
        for (const [id, plugin] of this.plugins) {
          if (plugin.rootPath.endsWith(pluginName)) {
            if (await this.deactivatePlugin(id)) {
              this.plugins.delete(id);
              this.recordLifecycle(id, 'unloaded', `source=watcher; event=remove; version=${plugin.manifest.version}`);
            } else {
              this.recordLifecycle(id, 'failed', 'source=watcher; event=remove; deactivation failed');
            }
            break;
          }
        }
      }
    );
  }

  pauseWatching(): boolean {
    const wasWatching = this.stopWatcher !== null;
    this.stopWatcher?.();
    this.stopWatcher = null;
    return wasWatching;
  }

  resumeWatching(): void {
    if (!this.stopWatcher) this.startWatching();
  }

  async installPluginFromDirectory(pluginDir: string): Promise<{
    success: boolean;
    pluginId?: string;
    rolledBack: boolean;
    error?: string;
  }> {
    const result = await loadPlugin(pluginDir);
    if (!result.success || !result.plugin) {
      return { success: false, rolledBack: false, error: result.error ?? '能力包加载失败' };
    }
    const incoming = result.plugin;
    const existing = this.plugins.get(incoming.manifest.id);
    if (existing?.rootPath.startsWith('builtin:')) {
      return { success: false, rolledBack: false, error: '能力包 ID 与内置能力冲突' };
    }
    try {
      this.validatePluginCapabilityManifest(incoming.manifest);
    } catch (error) {
      return {
        success: false,
        pluginId: incoming.manifest.id,
        rolledBack: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (existing && !await this.deactivatePlugin(existing.manifest.id)) {
      return {
        success: false,
        pluginId: incoming.manifest.id,
        rolledBack: false,
        error: '旧版本无法安全停用，已保留原能力包',
      };
    }
    this.plugins.set(incoming.manifest.id, incoming);
    if (await this.activatePlugin(incoming.manifest.id)) {
      return { success: true, pluginId: incoming.manifest.id, rolledBack: false };
    }

    const activationError = incoming.error ?? '能力包激活失败';
    this.plugins.delete(incoming.manifest.id);
    if (existing) {
      this.plugins.set(existing.manifest.id, existing);
      const restored = await this.activatePlugin(existing.manifest.id);
      return {
        success: false,
        pluginId: incoming.manifest.id,
        rolledBack: restored,
        error: restored ? activationError : `${activationError}；旧版本恢复失败`,
      };
    }
    return { success: false, pluginId: incoming.manifest.id, rolledBack: true, error: activationError };
  }

  async removePluginFromRegistry(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.rootPath.startsWith('builtin:')) return false;
    if (!await this.deactivatePlugin(pluginId)) return false;
    this.plugins.delete(pluginId);
    return true;
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
  // Plugin Management Methods
  // --------------------------------------------------------------------------
  // Plugin hook 表面已删除：零消费者，且 HookManager 不支持 in-process handler。
  // 将来若需插件拦截工具调用，需先给 HookManager 新增 in-process 执行器类型。

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

    if (!await this.deactivatePlugin(pluginId)) return false;

    // Builtin plugin: 没有磁盘路径，直接复用现有 entry 重新 activate
    if (plugin.rootPath.startsWith('builtin:')) {
      return this.activatePlugin(pluginId);
    }

    const result = await loadPlugin(plugin.rootPath);
    if (result.success && result.plugin) {
      this.plugins.set(pluginId, result.plugin);
      if (await this.activatePlugin(pluginId)) return true;
    }
    this.plugins.set(pluginId, plugin);
    await this.activatePlugin(pluginId);
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

/**
 * 本进程此刻真正激活的 builtin 插件 id。
 *
 * run stamp 的 `shape.plugins` 取这里而不取「请求装哪些」——请求值不等于结果：
 * 平台不匹配 / 依赖缺席 / activate 抛错都会让插件停在 error 态，而戳记若抄请求值，
 * 报告上就会写着装了、实际工具面空着（本单要测的正是这一格）。
 */
export function getActiveBuiltinPluginIds(): string[] {
  return pluginRegistry.getPlugins()
    .filter((plugin) => plugin.state === 'active' && plugin.rootPath.startsWith('builtin:'))
    .map((plugin) => plugin.manifest.id)
    .sort();
}

export async function initPluginSystem(): Promise<void> {
  const { getRemoteCapabilityRegistryService } = await import('../services/capabilities/remoteCapabilityRegistryService');
  await getRemoteCapabilityRegistryService().readRegistry();
  await pluginRegistry.initialize();
  const { getInternalFeatureHostRuntime } = await import('../internalFeatures/internalFeatureHostRuntime');
  await getInternalFeatureHostRuntime().loadInstalled();
}

export async function shutdownPluginSystem(): Promise<void> {
  await pluginRegistry.shutdown();
}
