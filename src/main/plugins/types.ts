// ============================================================================
// Plugin System Types
// ============================================================================

import type { Tool } from '../tools/types';
import type { HookEvent } from '../protocol/events';
import type { ToolModule } from '../protocol/tools';

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
  /** Plugin compatibility tags */
  generations?: string[];
  /** Required permissions */
  permissions?: PluginPermission[];
  /**
   * Host surfaces the plugin extends (tools / skills / theme / language).
   *
   * Step 7 PR 1: 原字段名 `capabilities`，重命名为 `surfaces` 以释放
   * `capabilities` 给"领域能力标签"。host 内部统一读 `manifest.surfaces`。
   */
  surfaces?: PluginSurface[];
  /**
   * 领域能力标签（kebab-case），供 CapabilityRecommender / Gap 提示语义匹配
   * 用，如 `['image-generation', 'image-processing']`。host 不做白名单校验，
   * 仅作为元数据投影给上层服务。
   */
  capabilities?: string[];
  /**
   * Platforms this plugin supports. Optional.
   *
   * Host 不强制阻止加载，仅作为 builtin plugin 跨平台标记 / 上游 marketplace
   * 过滤的元数据。typical 取值：`['darwin']` 表示仅 macOS（如 computer-use），
   * `['darwin', 'win32', 'linux']` 表示跨平台（如 browser-control）。
   */
  platforms?: PluginPlatform[];
  /**
   * 该插件依赖的原生二进制 / runtime（仅用于文档披露，host 不做存在性校验）。
   *
   * 例如 `['playwright', 'ffmpeg']` 提示该插件需要外部命令行工具。typical 用
   * 法：让审核者 / 用户在安装前了解依赖；host 实际执行仍走插件代码自己的
   * 错误处理路径。
   */
  nativeDeps?: string[];
}

/**
 * Supported platforms for plugin `platforms` field.
 */
export type PluginPlatform = 'darwin' | 'win32' | 'linux';

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
 * Plugin surface types — what host surface the plugin extends.
 *
 * Step 7 PR 1: 原类型名 `PluginCapability`，重命名为 `PluginSurface` 以
 * 释放 "capability" 给"领域能力标签"语义（CapabilityRecommender 用）。
 * 字段值域不变，行为兼容。
 */
export type PluginSurface =
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
  /**
   * 注册 v1 形态的工具（Tool）。
   *
   * 命名约定：工具名会自动加 `${pluginId}:` 前缀防命名冲突。
   *
   * 同名重复注册（包括与 registerToolModule 双通道冲突）会抛错，与 v2 对称。
   * 热重载场景由 reloadPlugin 先 deactivate 清理 registeredTools 数组,
   * 不依赖 idempotent overwrite。
   */
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

  // --------------------------------------------------------------------------
  // PluginAPI v2 扩展 — 见文件底部的类型定义和实现说明
  // --------------------------------------------------------------------------

  /**
   * PluginAPI 版本号，用于插件运行时能力探测。
   * v1 = 仅 tools/hooks/storage；v2 = 增加 api-key 取用、用户身份、常量投影、ToolModule 注册。
   */
  readonly pluginApiVersion: 2;

  /**
   * 获取 provider 的 API key（解密后明文）。
   *
   * 安全限制：
   * - provider 必须在 `PluginApiKeyProvider` 白名单内，运行时再做 set 校验防 TS 类型擦除绕过
   * - 返回值是明文 key，插件不应 log / 持久化 / 通过网络外发
   * - Registry 不审计 key 用途，由插件 manifest 的 permissions 字段配合 review 流程把关
   */
  getApiKey: (provider: PluginApiKeyProvider) => Promise<string | undefined>;

  /**
   * 获取当前登录用户的精简投影。未登录返回 null。
   *
   * 安全限制：
   * - 仅返回 `{ id, isAdmin }`，不暴露 email / token / profile 全量字段
   * - 走 admin trust-gate：未经服务端验证的 cached session 强制 `isAdmin = false`
   *   （与 authService.getPublicUserForCurrentTrust 的策略一致）
   */
  getCurrentUser: () => PluginUserSnapshot | null;

  /**
   * 按命名空间读取项目常量快照。
   *
   * 安全限制：
   * - 返回 Readonly + Object.freeze，插件无法改写宿主常量
   * - providers namespace 已过滤内部代理 URL（zhipu/zhipuCoding/kimiK25），
   *   插件拿到的只是面向第三方的公开端点
   */
  getConstants: (namespace: PluginConstantsNamespace) => Readonly<Record<string, unknown>>;

  /**
   * 注册 v2 形态的工具模块（ToolModule，区别于 v1 的 Tool）。
   *
   * 命名约定：
   * - 默认工具名会自动加 `${pluginId}:` 前缀，与 v1 registerTool 保持一致
   * - 同名重复注册（包括与 registerTool 双通道冲突）会抛错
   *
   * Opt-out 前缀（`options.prefixWithPluginId = false`）：
   * - **仅供 builtin plugin 使用**。builtin plugin 与 host 同 bundle 编译/分发，
   *   "防命名冲突"对其没意义；保留原工具名可避免破坏 executionPhase 分类、
   *   ToolSearch deferredTools 注册、LLM prompt / cache / eval baseline。
   * - 第三方插件不应使用此选项，安全模型依赖 `${pluginId}:` 前缀防冲突。
   * - 即使 opt-out，重复注册同名工具仍然抛错（命名冲突检查不跳过）。
   */
  registerToolModule: (
    module: ToolModule,
    options?: PluginRegisterToolModuleOptions,
  ) => void;
}

/**
 * `registerToolModule` 的可选参数。
 *
 * 字段：
 * - `prefixWithPluginId`：默认 `true`，自动加 `${pluginId}:` 前缀。
 *   传 `false` 跳过前缀（仅 builtin plugin 应当使用）。
 */
export interface PluginRegisterToolModuleOptions {
  prefixWithPluginId?: boolean;
}

// ============================================================================
// PluginAPI v2 扩展
// ============================================================================

/**
 * 允许插件读取 API key 的 provider 白名单。
 * 新增 provider 时必须同步更新 pluginRegistry.ts 里的 ALLOWED_PROVIDERS 运行时 Set。
 */
export type PluginApiKeyProvider =
  | 'deepseek' | 'claude' | 'openai' | 'gemini' | 'groq'
  | 'zhipu' | 'qwen' | 'moonshot' | 'minimax' | 'perplexity'
  | 'grok' | 'openrouter' | 'volcengine' | 'longcat' | 'xiaomi';

/**
 * 允许插件读取的常量命名空间。
 * 实际投影内容见 pluginRegistry.ts 里的 CONSTANTS_BUCKETS。
 */
export type PluginConstantsNamespace = 'models' | 'providers' | 'pricing' | 'timeouts';

/**
 * 暴露给插件的用户身份精简投影。
 * 走 admin trust-gate — 未经服务端验证的 session 强制 `isAdmin: false`。
 */
export interface PluginUserSnapshot {
  id?: string;
  isAdmin: boolean;
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
