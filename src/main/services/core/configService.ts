// ============================================================================
// Config Service - Manage application settings
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { app } from '../../platform';
import type { AppSettings, ModelProvider } from '../../../shared/contract';
import type { IReadConfigService, ServiceApiKey } from '../../../shared/contract/configService';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getSecureStorage } from './secureStorage';
import { createLogger } from '../infra/logger';
import { getPolicyEngine } from '../../permissions/policyEngine';
import { setProviderConcurrencyOverrides } from '../../model/concurrencyLimiter';
import { setProviderProxyOverrides } from '../../model/providers/shared';
import type { ProxyMode, ModelEntrySettings } from '../../../shared/contract/settings';
import type { SharedProviderConfig, SharedServiceKeyConfig } from '../cloud/builtinConfig';
import { isDynamicCustomProviderId } from '../../../shared/modelRuntime';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  MODEL_API_ENDPOINTS,
} from '../../../shared/constants';

const logger = createLogger('ConfigService');

// config.json 外部编辑热重载:与 soulLoader/skillWatcher 一致的去抖窗口
const CONFIG_WATCH_DEBOUNCE_MS = 500;
// save() 自身写盘后的静默窗口,避免本进程写入触发热重载回环
const CONFIG_SELF_WRITE_WINDOW_MS = 1500;
const CLOUD_MANAGED_SERVICE_KEY_PREFIX = 'cloud-service-key:';
const CLOUD_MANAGED_SERVICE_BASE_URL_PREFIX = 'serviceBaseUrl.cloud.';
const SHARED_SEARCH_SERVICE_KEYS = ['brave', 'exa', 'openai', 'perplexity', 'tavily'] as const;

function getCloudManagedServiceKeyId(service: ServiceApiKey): string {
  return `${CLOUD_MANAGED_SERVICE_KEY_PREFIX}${service}`;
}

function getCloudManagedServiceBaseUrlId(service: ServiceApiKey): `serviceBaseUrl.${string}` {
  return `${CLOUD_MANAGED_SERVICE_BASE_URL_PREFIX}${service}`;
}

const moduleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Security Utilities
// ============================================================================

/**
 * Check if running in production (packaged app)
 */
export function isProduction(): boolean {
  return app?.isPackaged ?? process.env.NODE_ENV === 'production';
}

/**
 * Sanitize sensitive data for logging
 * Masks API keys, tokens, and other sensitive strings
 */
export function sanitizeForLogging(value: unknown): unknown {
  if (typeof value === 'string') {
    // Mask API keys (sk-xxx, key-xxx, etc.)
    if (/^(sk-|key-|pk-|api-)/i.test(value)) {
      return value.slice(0, 7) + '***' + value.slice(-4);
    }
    // Mask JWTs
    if (value.includes('.') && value.split('.').length === 3 && value.length > 50) {
      return value.slice(0, 10) + '...[JWT]...' + value.slice(-10);
    }
    // Mask long hex strings (potential keys/tokens)
    if (/^[a-f0-9]{32,}$/i.test(value)) {
      return value.slice(0, 8) + '***' + value.slice(-4);
    }
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(sanitizeForLogging);
    }
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Always mask keys with sensitive names
      if (/key|token|secret|password|credential|auth/i.test(k)) {
        sanitized[k] = typeof v === 'string' ? sanitizeForLogging(v) : '[REDACTED]';
      } else {
        sanitized[k] = sanitizeForLogging(v);
      }
    }
    return sanitized;
  }

  return value;
}

/**
 * Safe console.log that automatically sanitizes sensitive data
 */
export function safeLog(message: string, ...args: unknown[]): void {
  logger.info(message, ...args.map(sanitizeForLogging));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return null;
    }
    normalized[key] = item;
  }
  return normalized;
}

function normalizeApiKey(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeBaseUrl(value?: string): string | undefined {
  const normalized = normalizeApiKey(value);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return normalized.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

// Load .env file from project root or app resources
import { app as electronApp } from '../../platform';

function loadEnvFile(): void {
  // Try multiple paths for .env file
  const appPath = electronApp?.getAppPath?.() || '';
  const userDataPath = electronApp?.getPath?.('userData') || '';

  // For packaged app, Resources folder is at appPath/../
  const resourcesPath = appPath ? path.join(appPath, '..') : '';

  const possiblePaths = [
    path.join(process.cwd(), '.env'),                              // Development: project root
    path.join(moduleDir, '../../..', '.env'),                       // Development: relative to dist
    path.join(resourcesPath, '.env'),                               // Production: Resources folder
    path.join(userDataPath, '.env'),                                // Production: user data folder
    path.join(appPath, '.env'),                                     // Production: app.asar
    path.join(appPath, '..', '.env'),                               // Production: parent of app.asar
  ].filter(p => p && p.length > 0);

  logger.debug('Trying .env paths:');
  for (const envPath of possiblePaths) {
    logger.debug('  -', envPath);
    try {
      const result = dotenv.config({ path: envPath });
      if (!result.error) {
        logger.info('Loaded .env from:', envPath);
        return;
      }
    } catch {
      // Continue to next path
    }
  }
  logger.info('No .env file found, using environment variables only');
}

loadEnvFile();
logger.info('SUPABASE_URL from env:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');

// Default settings
const DEFAULT_SETTINGS: AppSettings = {
  models: {
    default: DEFAULT_PROVIDER,  // 默认主力 provider
    providers: {
      deepseek: { enabled: true },
      claude: { enabled: true },
      openai: { enabled: false },
      gemini: { enabled: false },
      groq: { enabled: false },
      local: { enabled: true },
      zhipu: { enabled: true },     // 智谱默认启用 (视觉 + 备用语言)
      qwen: { enabled: false },
      moonshot: { enabled: true },  // Kimi K2.5 包月套餐
      minimax: { enabled: false },
      perplexity: { enabled: false },
      grok: { enabled: false },
      openrouter: { enabled: false },
      volcengine: { enabled: false },
      longcat: { enabled: false },
      xiaomi: { enabled: true },     // 小米 MiMo Token Plan Max 包月套餐
      custom: { enabled: false, baseUrl: undefined, displayName: 'Custom Provider' },
    },
    agentEngines: {},
    // 按用途路由模型 — 引用 DEFAULT_MODELS 常量
    routing: {
      code: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.code },
      vision: { provider: 'zhipu', model: DEFAULT_MODELS.vision },
      fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
    },
  },
  workspace: {
    recentDirectories: [],
  },
  permissions: {
    autoApprove: {
      read: true,
      write: false,
      execute: false,
      network: false,
    },
    blockedCommands: [
      'rm -rf /',
      'rm -rf ~',
      'sudo rm',
      ':(){:|:&};:',
    ],
    // SECURITY: devModeAutoApprove only enabled in development
    // In production (packaged app), this is always false
    devModeAutoApprove: false,
  },
  ui: {
    theme: 'system',
    fontSize: 14,
    showToolCalls: true,
    language: 'zh',
    disclosureLevel: 'standard',
  },
  // 云端 Agent 配置
  cloud: {
    enabled: false,
    endpoint: undefined,
    apiKey: undefined,
    warmupOnInit: true,
  },
  // GUI Agent 配置
  guiAgent: {
    enabled: false,
    displayWidth: 1920,
    displayHeight: 1080,
  },
  // 原生连接器默认全关
  connectors: {
    enabledNative: [],
  },
  contextCompression: {
    enabled: true,
    warningThreshold: 0.75,
    criticalThreshold: 0.85,
    preserveRecentCount: 10,
    triggerTokens: 100000,
    compactProvider: 'moonshot',
    compactModel: DEFAULT_MODELS.compact,
    auditEnabled: true,
  },
  appshots: {
    enabled: true,
    targetSession: 'current',
  },
};

export class ConfigService implements IReadConfigService {
  private settings: AppSettings = DEFAULT_SETTINGS;
  private configPath: string;
  private configWatcher: FSWatcher | null = null;
  private configWatchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelfWriteAt = 0;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.configPath = path.join(userDataPath, 'config.json');
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const loaded = parseJsonValue(data);
      this.settings = isRecord(loaded)
        ? this.mergeSettings(DEFAULT_SETTINGS, loaded as Partial<AppSettings>)
        : { ...DEFAULT_SETTINGS };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        logger.error('Failed to load config:', error);
      }
      // Use default settings
      this.settings = { ...DEFAULT_SETTINGS };
    }

    // Try to restore settings from Keychain (survives app reinstall)
    await this.restoreFromKeychain();
    this.migrateLegacyLongCatProvider();
    this.enableDefaultLocalProvider();

    // Save merged settings
    await this.save();

    // 加载用户级权限规则到 PolicyEngine（subagent 继承机制依赖这一步在 spawn 之前完成）
    this.applyUserPermissionRules();

    // 把用户配置的 per-provider 并发上限推入限流器（覆盖出厂默认）
    this.applyProviderConcurrencyOverrides();

    // 把用户配置的 per-provider 代理模式推入 getHttpsAgent（覆盖内置 OVERSEAS 默认）
    this.applyProviderProxyOverrides();

    // 兼容性标记：旧配置首次升级到 6.8.x 时，如果用户尚未声明 inheritance，
    // 打上 _legacyPermissions=true 由 UI 弹一次性引导。strict-inherit 仍然作为默认行为。
    if (this.settings.permissions.inheritance === undefined) {
      this.settings.permissions._legacyPermissions = true;
      logger.info('Settings upgrade: permissions.inheritance not set, marked as legacy (default strict-inherit applies).');
      // 注意：不主动 save，等用户在 UI 上做选择后再持久化，避免悄悄改写用户配置。
    }
  }

  /**
   * 把 settings.permissions.{deny, ask, allow} 注入 PolicyEngine，供 UserConfigSource 使用。
   * 启动期间调用一次；用户在 UI 上更新规则时通过 reloadUserPermissionRules 重新调用。
   */
  private applyUserPermissionRules(): void {
    try {
      const policy = getPolicyEngine();
      const perms = this.settings.permissions;
      policy.loadUserRules({
        deny: perms.deny,
        ask: perms.ask,
        allow: perms.allow,
      });
      logger.info('User permission rules applied', {
        deny: perms.deny?.length ?? 0,
        ask: perms.ask?.length ?? 0,
        allow: perms.allow?.length ?? 0,
        inheritance: perms.inheritance ?? 'strict-inherit (default)',
      });
    } catch (error) {
      logger.error('Failed to apply user permission rules:', error);
    }
  }

  /**
   * 公开接口：UI 改了 permissions.deny/ask/allow 后调一次，重新生效。
   */
  reloadUserPermissionRules(): void {
    this.applyUserPermissionRules();
  }

  /**
   * 从磁盘重新加载 config.json 到内存,并重跑会注入全局状态的 apply 函数。
   * 用于"外部直接编辑 config.json"后的热生效(API Key / 模型路由 / 权限 / 并发 / 代理
   * 这些消费方都是现读,内存刷新后下次调用即生效)。
   * 刻意不做 restoreFromKeychain / migrate / save —— 那些是启动一次性逻辑,
   * 且 save 会写盘从而触发 watcher 回环。
   */
  async reloadFromDisk(): Promise<boolean> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const loaded = parseJsonValue(data);
      if (!isRecord(loaded)) {
        logger.warn('Config reload skipped: file is not a JSON object');
        return false;
      }
      this.settings = this.mergeSettings(DEFAULT_SETTINGS, loaded as Partial<AppSettings>);
      // 与 initialize 末尾保持一致:重新注入需要全局状态的配置
      this.applyUserPermissionRules();
      this.applyProviderConcurrencyOverrides();
      this.applyProviderProxyOverrides();
      logger.info('Config hot-reloaded from disk');
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') return false;
      logger.error('Failed to reload config from disk:', error);
      return false;
    }
  }

  /**
   * 监听 config.json 的外部改动并热重载。app 内通过 updateSettings 的修改
   * 会经 save() 标记 lastSelfWriteAt 被跳过,只响应外部编辑。
   * @param onReloaded 热重载成功后的回调(供上层广播给 renderer 等)
   */
  startWatchingConfigFile(onReloaded?: () => void): void {
    this.stopWatchingConfigFile();
    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);
    try {
      this.configWatcher = watch(dir, (_eventType, filename) => {
        if (filename !== base) return;
        // 跳过本进程 save() 触发的写入,避免热重载回环
        if (Date.now() - this.lastSelfWriteAt < CONFIG_SELF_WRITE_WINDOW_MS) return;
        if (this.configWatchTimer) clearTimeout(this.configWatchTimer);
        this.configWatchTimer = setTimeout(() => {
          void this.reloadFromDisk().then((ok) => {
            if (ok && onReloaded) onReloaded();
          });
        }, CONFIG_WATCH_DEBOUNCE_MS);
      });
      logger.info('Watching config.json for external edits', { path: this.configPath });
    } catch (error) {
      logger.warn('Failed to watch config file', { error: String(error) });
    }
  }

  stopWatchingConfigFile(): void {
    if (this.configWatchTimer) {
      clearTimeout(this.configWatchTimer);
      this.configWatchTimer = null;
    }
    if (this.configWatcher) {
      try {
        this.configWatcher.close();
      } catch {
        // ignore
      }
      this.configWatcher = null;
    }
  }

  /**
   * 把 settings.models.providers[*].maxConcurrent 推入并发限流器（覆盖出厂默认）。
   * 启动加载时调用一次；用户在模型配置页保存 provider 设置后再次调用以热更新。
   */
  private applyProviderConcurrencyOverrides(): void {
    try {
      const providers = this.settings.models?.providers ?? {};
      const map: Record<string, { maxConcurrent: number }> = {};
      for (const [provider, cfg] of Object.entries(providers)) {
        const mc = cfg?.maxConcurrent;
        if (typeof mc === 'number' && mc > 0) {
          map[provider] = { maxConcurrent: mc };
        }
      }
      setProviderConcurrencyOverrides(map);
      logger.info('Provider concurrency overrides applied', { overridden: Object.keys(map).length });
    } catch (error) {
      logger.error('Failed to apply provider concurrency overrides:', error);
    }
  }

  /**
   * 把 settings.models.providers[*].proxyMode 推入 getHttpsAgent 的 per-provider 覆盖
   * （覆盖内置 OVERSEAS_PROVIDERS 默认）。启动加载时调用一次；用户在模型配置页保存后再次调用热更新。
   */
  private applyProviderProxyOverrides(): void {
    try {
      const providers = this.settings.models?.providers ?? {};
      const map: Record<string, ProxyMode> = {};
      for (const [provider, cfg] of Object.entries(providers)) {
        const mode = cfg?.proxyMode;
        if (mode === 'direct' || mode === 'proxy') {
          map[provider] = mode;
        }
      }
      setProviderProxyOverrides(map);
      logger.info('Provider proxy overrides applied', { overridden: Object.keys(map).length });
    } catch (error) {
      logger.error('Failed to apply provider proxy overrides:', error);
    }
  }

  private migrateLegacyLongCatProvider(): void {
    const providers = this.settings.models.providers;
    const legacy = providers.custom;
    if (!legacy) return;

    const baseUrl = legacy.baseUrl?.toLowerCase() || '';
    const displayName = legacy.displayName?.trim().toLowerCase() || '';
    const looksLikeLongCat = baseUrl.includes('api.longcat.chat') || displayName === 'longcat';
    if (!looksLikeLongCat) return;

    const legacyModel = legacy.model || 'LongCat-2.0-Preview';
    const canonicalModel = legacyModel.toLowerCase() === 'longcat-2.0-preview'
      ? 'LongCat-2.0-Preview'
      : legacyModel;
    const legacyModelSettings = legacy.models?.[legacyModel] ?? legacy.models?.[canonicalModel];

    providers.longcat = {
      ...providers.longcat,
      ...legacy,
      enabled: legacy.enabled ?? true,
      displayName: 'LongCat',
      baseUrl: legacy.baseUrl || MODEL_API_ENDPOINTS.longcat,
      model: canonicalModel,
      models: {
        ...legacy.models,
        [canonicalModel]: {
          enabled: true,
          label: 'LongCat 2.0 Preview',
          capabilities: ['general', 'code', 'reasoning', 'longContext'],
          supportsTool: true,
          supportsVision: false,
          supportsStreaming: true,
          ...legacyModelSettings,
        },
      },
    };

    providers.custom = {
      ...legacy,
      enabled: false,
      displayName: 'Custom Provider',
      baseUrl: undefined,
      model: 'custom-model',
      models: undefined,
    };

    if (this.settings.models.default === 'custom') {
      this.settings.models.default = 'longcat';
    }
    if (this.settings.models.defaultProvider === 'custom') {
      this.settings.models.defaultProvider = 'longcat';
    }
    for (const route of Object.values(this.settings.models.routing)) {
      if (route.provider === 'custom') {
        route.provider = 'longcat';
        if (route.model.toLowerCase() === 'longcat-2.0-preview') {
          route.model = 'LongCat-2.0-Preview';
        }
      }
    }

    try {
      const storage = getSecureStorage();
      const legacyKey = storage.getApiKey('custom');
      if (legacyKey && !storage.getApiKey('longcat')) {
        storage.setApiKey('longcat', legacyKey);
      }
    } catch (error) {
      logger.warn('Failed to migrate LongCat API key from custom provider', error);
    }

    logger.info('Migrated legacy custom LongCat provider to official longcat provider');
  }

  private enableDefaultLocalProvider(): void {
    const local = this.settings.models.providers.local;
    if (!local) {
      this.settings.models.providers.local = { enabled: true };
      return;
    }

    const hasCustomLocalSettings = Boolean(
      local.baseUrl
      || local.model
      || local.displayName
      || local.protocol
      || local.updatedAt
      || local.apiKeyConfigured
      || local.maxConcurrent
      || local.proxyMode
      || local.temperature
      || local.maxTokens
      || (local.models && Object.keys(local.models).length > 0)
    );

    if (local.enabled === false && !hasCustomLocalSettings) {
      local.enabled = true;
      logger.info('Settings upgrade: enabled default local provider');
    }
  }

  // Restore user settings from Keychain (for app reinstall scenarios)
  private async restoreFromKeychain(): Promise<void> {
    try {
      const storage = getSecureStorage();
      const keychainSettings = await storage.getSettingsFromKeychain();

      if (keychainSettings) {
        logger.info('Restoring settings from Keychain:', Object.keys(keychainSettings));

        // === 核心配置 ===


        // Restore model provider
        if (keychainSettings.modelProvider && typeof keychainSettings.modelProvider === 'string') {
          // this.settings.models.default = keychainSettings.modelProvider as ModelProvider; // Disabled: use config.json value
        }

        // Restore permissionMode
        if (keychainSettings.permissionMode && typeof keychainSettings.permissionMode === 'string') {
          const validModes = ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'delegate'];
          if (validModes.includes(keychainSettings.permissionMode)) {
            this.settings.permissions.permissionMode = keychainSettings.permissionMode as AppSettings['permissions']['permissionMode'];
            logger.info('Restored permissionMode from Keychain:', keychainSettings.permissionMode);
          }
        }

        // Restore devModeAutoApprove
        if (typeof keychainSettings.devModeAutoApprove === 'boolean') {
          this.settings.permissions.devModeAutoApprove = keychainSettings.devModeAutoApprove;
        }

        // === UI 偏好 ===

        // Restore language
        if (keychainSettings.language && typeof keychainSettings.language === 'string') {
          const validLanguages = ['zh', 'en'];
          if (validLanguages.includes(keychainSettings.language)) {
            this.settings.ui.language = keychainSettings.language as 'zh' | 'en';
          }
        }

        // Restore theme
        if (keychainSettings.theme && typeof keychainSettings.theme === 'string') {
          const validThemes = ['light', 'dark', 'system'];
          if (validThemes.includes(keychainSettings.theme)) {
            this.settings.ui.theme = keychainSettings.theme as 'light' | 'dark' | 'system';
          }
        }

        // Restore fontSize
        if (typeof keychainSettings.fontSize === 'number') {
          this.settings.ui.fontSize = keychainSettings.fontSize;
        }

        // Restore showToolCalls
        if (typeof keychainSettings.showToolCalls === 'boolean') {
          this.settings.ui.showToolCalls = keychainSettings.showToolCalls;
        }

        // Restore disclosureLevel
        if (keychainSettings.disclosureLevel && typeof keychainSettings.disclosureLevel === 'string') {
          const validLevels = ['simple', 'standard', 'advanced', 'expert'];
          if (validLevels.includes(keychainSettings.disclosureLevel)) {
            this.settings.ui.disclosureLevel = keychainSettings.disclosureLevel as 'simple' | 'standard' | 'advanced' | 'expert';
          }
        }

        // === 超时配置 ===

        // Restore timeout complexity
        if (keychainSettings.timeoutComplexity && typeof keychainSettings.timeoutComplexity === 'string') {
          const validComplexities = ['simple', 'medium', 'complex'];
          if (validComplexities.includes(keychainSettings.timeoutComplexity)) {
            if (!this.settings.timeouts) {
              this.settings.timeouts = { complexity: 'medium', simple: 30000, medium: 120000, complex: 600000 };
            }
            this.settings.timeouts.complexity = keychainSettings.timeoutComplexity as 'simple' | 'medium' | 'complex';
          }
        }

        // === 模型路由 ===

        // Restore model routing
        if (keychainSettings.modelRouting && typeof keychainSettings.modelRouting === 'object') {
          const routing = keychainSettings.modelRouting as Record<string, { provider: string; model: string }>;
          for (const key of ['code', 'vision', 'fast', 'gui'] as const) {
            if (routing[key]?.provider && routing[key]?.model) {
              this.settings.models.routing[key] = routing[key] as { provider: ModelProvider; model: string };
            }
          }
        }

        // === 确认门控 ===

        // Restore confirmation gate policy
        if (keychainSettings.confirmationPolicy && typeof keychainSettings.confirmationPolicy === 'string') {
          const validPolicies = ['always_ask', 'always_approve', 'ask_if_dangerous', 'session_approve'];
          if (validPolicies.includes(keychainSettings.confirmationPolicy)) {
            if (!this.settings.confirmationGate) {
              this.settings.confirmationGate = { policy: 'ask_if_dangerous' };
            }
            this.settings.confirmationGate.policy = keychainSettings.confirmationPolicy as AppSettings['confirmationGate'] extends { policy: infer P } ? P : never;
          }
        }

        // === maxTokens ===

        if (typeof keychainSettings.maxTokens === 'number') {
          (this.settings as AppSettings & { maxTokens?: number }).maxTokens = keychainSettings.maxTokens;
        }
      }
    } catch (error) {
      logger.error('Failed to restore from Keychain:', error);
    }
  }

  getSettings(): AppSettings {
    // Deep clone settings
    const settings = JSON.parse(JSON.stringify(this.settings)) as AppSettings;

    // Populate API keys from secure storage for UI display
    const storage = getSecureStorage();
    if (settings.models?.providers) {
      for (const provider of Object.keys(settings.models.providers)) {
        const apiKey = storage.getApiKey(provider);
        const apiKeyConfigured = Boolean(apiKey || this.getApiKey(provider as ModelProvider));
        settings.models.providers[provider as keyof typeof settings.models.providers].apiKeyConfigured = apiKeyConfigured;
      }
    }

    return settings;
  }

  /**
   * Check if devModeAutoApprove is enabled
   * SECURITY: Always returns false in production (packaged app)
   */
  isDevModeAutoApproveEnabled(): boolean {
    // In production, devModeAutoApprove is ALWAYS disabled
    if (isProduction()) {
      return false;
    }
    return this.settings.permissions.devModeAutoApprove;
  }

  /**
   * Set devModeAutoApprove setting
   * SECURITY: Logs a warning when enabled, ignored in production
   */
  async setDevModeAutoApprove(enabled: boolean): Promise<void> {
    if (isProduction()) {
      logger.warn('devModeAutoApprove cannot be enabled in production builds');
      return;
    }

    if (enabled) {
      logger.warn('devModeAutoApprove enabled - all tool executions will be auto-approved!');
      logger.warn('This should only be used for development and testing.');
    }

    this.settings.permissions.devModeAutoApprove = enabled;
    await this.save();
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<void> {
    // SECURITY: Prevent enabling devModeAutoApprove in production
    if (updates.permissions?.devModeAutoApprove !== undefined) {
      if (isProduction() && updates.permissions.devModeAutoApprove) {
        logger.warn('Ignoring devModeAutoApprove=true in production');
        updates.permissions.devModeAutoApprove = false;
      }
    }

    // Extract and securely store API keys from model provider configs
    if (updates.models?.providers) {
      const storage = getSecureStorage();
      for (const [provider, config] of Object.entries(updates.models.providers)) {
        if (config && 'apiKey' in config && config.apiKey) {
          // Store API key securely
          storage.setApiKey(provider, config.apiKey);
          logger.info('Stored API key to secure storage', { provider });
          // Remove from config to avoid storing in plaintext
          delete (config as unknown as Record<string, unknown>).apiKey;
        }
      }
    }

    this.settings = this.mergeSettings(this.settings, updates);
    await this.save();

    // 用户更新 permissions.{deny,ask,allow} 后立即重新加载到 PolicyEngine
    if (updates.permissions && (
      updates.permissions.deny !== undefined ||
      updates.permissions.ask !== undefined ||
      updates.permissions.allow !== undefined
    )) {
      this.applyUserPermissionRules();
    }

    // 用户在模型配置页改了 provider（含 maxConcurrent / proxyMode）后热更新
    if (updates.models?.providers) {
      this.applyProviderConcurrencyOverrides();
      this.applyProviderProxyOverrides();
    }
  }

  async setApiKey(provider: ModelProvider, apiKey: string): Promise<void> {
    // Store API key in secure storage (encrypted)
    const storage = getSecureStorage();
    storage.setApiKey(provider, apiKey);

    // Update settings (without storing the key in plaintext)
    this.settings.models.providers[provider] = {
      ...this.settings.models.providers[provider],
      enabled: true,
      // Don't store apiKey in config.json anymore
    };
    await this.save();
  }

  /**
   * 协调控制面下发的「团队共享 provider（中转站）」到本地 settings。
   *
   * 入参 `providers` 是控制面**已按本人 entitlement 过滤**后的列表（无权的在网关层就被剥离）。
   * 本方法做幂等 reconcile：
   *  - 下发列表里的 → upsert 成 managedByCloud 的动态 custom provider（key 存 SecureStorage，不落明文）；
   *  - 之前托管、本次不再下发的 → 删除（管理员关闭/吊销/kill switch 后，下次拉取即自动消失）。
   *
   * 仅在「成功拿到可信 cloud config」后调用——离线/拉取失败时不要调用（避免误删本地已下发的）。
   */
  async reconcileManagedProviders(providers: SharedProviderConfig[]): Promise<void> {
    const storage = getSecureStorage();
    const desired = new Map(
      (providers ?? [])
        .filter((p) => p && typeof p.id === 'string' && isDynamicCustomProviderId(p.id) && p.baseUrl && p.apiKey)
        .map((p) => [p.id, p] as const),
    );

    let changed = false;

    // 1) 移除：之前托管、本次不再下发的
    for (const id of Object.keys(this.settings.models.providers)) {
      const existing = this.settings.models.providers[id];
      if (existing?.managedByCloud && !desired.has(id)) {
        delete this.settings.models.providers[id];
        storage.deleteApiKey(id);
        changed = true;
        logger.info('Removed managed shared provider (no longer delivered)', { provider: id });
      }
    }

    // 2) upsert：本次下发的
    for (const [id, p] of desired) {
      storage.setApiKey(id, p.apiKey);
      const models: Record<string, ModelEntrySettings> = {};
      for (const m of p.models ?? []) {
        if (!m?.id) continue;
        models[m.id] = { enabled: true, ...(m.label ? { label: m.label } : {}) };
      }
      this.settings.models.providers[id] = {
        ...this.settings.models.providers[id],
        enabled: true,
        managedByCloud: true,
        baseUrl: p.baseUrl,
        displayName: p.displayName,
        protocol: p.protocol ?? 'openai',
        billingMode: p.billingMode ?? 'unknown',
        ...(Object.keys(models).length > 0 ? { models } : {}),
      };
      // 托管 provider 的 key 不落明文 settings，只进 SecureStorage（对齐普通 provider）
      delete (this.settings.models.providers[id] as { apiKey?: string }).apiKey;
      changed = true;
    }

    // 零配置兜底：当前默认 provider 不可用（无 key 且非 local）时，把共享 provider 的首个模型设为激活默认，
    // 让没配过 key 的同事登录后直接能聊。已有可用默认（含用户自己配的 key）则不动——尊重用户选择。
    if (desired.size > 0) {
      const currentDefault = this.settings.models.default;
      const currentUsable = currentDefault === 'local'
        || Boolean(this.getApiKey(currentDefault as ModelProvider));
      if (!currentUsable) {
        const [firstId, firstProvider] = [...desired][0];
        const firstModel = firstProvider.models?.[0]?.id;
        if (firstModel) {
          this.settings.models.default = firstId;
          this.settings.models.defaultProvider = firstId as ModelProvider;
          this.settings.models.providers[firstId]!.model = firstModel;
          changed = true;
          logger.info('Set shared provider as default model (no usable model before)', {
            provider: firstId,
            model: firstModel,
          });
        }
      }
    }

    if (changed) {
      await this.save();
      this.applyProviderConcurrencyOverrides();
      this.applyProviderProxyOverrides();
    }
  }

  /**
   * 协调控制面下发的团队共享服务 key 到本地 SecureStorage。
   *
   * 与模型 shared provider 不同，搜索服务 id（tavily/brave 等）是固定的，直接覆盖会误伤用户自己配的 key。
   * 因此云端 key 存到独立前缀，只在 getServiceApiKey() 找不到用户 key 时作为 fallback。
   */
  async reconcileManagedServiceApiKeys(keys: SharedServiceKeyConfig[]): Promise<void> {
    const storage = getSecureStorage();
    const desired = new Map(
      (keys ?? [])
        .filter((entry) => (
          entry
          && SHARED_SEARCH_SERVICE_KEYS.includes(entry.service)
          && typeof entry.apiKey === 'string'
          && entry.apiKey.trim().length > 0
        ))
        .map((entry) => [entry.service, entry] as const),
    );

    let changed = false;
    for (const service of SHARED_SEARCH_SERVICE_KEYS) {
      const storageId = getCloudManagedServiceKeyId(service);
      const baseUrlStorageId = getCloudManagedServiceBaseUrlId(service);
      if (!desired.has(service) && storage.getApiKey(storageId)) {
        storage.deleteApiKey(storageId);
        changed = true;
      }
      if (!desired.has(service) && storage.get(baseUrlStorageId)) {
        storage.delete(baseUrlStorageId);
        changed = true;
      }
    }

    for (const [service, entry] of desired) {
      storage.setApiKey(getCloudManagedServiceKeyId(service), entry.apiKey);
      const baseUrlStorageId = getCloudManagedServiceBaseUrlId(service);
      const baseUrl = normalizeBaseUrl(entry.baseUrl);
      if (baseUrl) {
        storage.set(baseUrlStorageId, baseUrl);
      } else if (storage.get(baseUrlStorageId)) {
        storage.delete(baseUrlStorageId);
      }
      changed = true;
    }

    if (changed) {
      logger.info('Reconciled managed shared service API keys', {
        services: [...desired.keys()],
      });
    }
  }

  getApiKey(provider: ModelProvider): string | undefined {
    // Priority: secure storage > environment variable
    const storage = getSecureStorage();
    const secureKey = normalizeApiKey(storage.getApiKey(provider));
    if (secureKey) return secureKey;

    // Legacy: check config.json (for migration)
    const configKey = normalizeApiKey(this.settings.models.providers[provider]?.apiKey);
    if (configKey) {
      // Migrate to secure storage
      storage.setApiKey(provider, configKey);
      // Remove from config (will be saved on next settings update)
      delete this.settings.models.providers[provider]?.apiKey;
      return configKey;
    }

    // Fallback to environment variable
    const envKeyMap: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      claude: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      groq: 'GROQ_API_KEY',
      local: '',
      zhipu: 'ZHIPU_API_KEY',
      qwen: 'QWEN_API_KEY',
      moonshot: 'MOONSHOT_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      grok: 'GROK_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      volcengine: 'VOLCENGINE_API_KEY',
      longcat: 'LONGCAT_API_KEY',
      xiaomi: 'XIAOMI_API_KEY',
      custom: 'CUSTOM_PROVIDER_API_KEY',
    };

    const envKey = envKeyMap[provider];
    const primaryEnvKey = normalizeApiKey(envKey ? process.env[envKey] : undefined);
    if (primaryEnvKey) return primaryEnvKey;

    if (provider === 'moonshot') {
      return normalizeApiKey(process.env.KIMI_K25_API_KEY);
    }

    return undefined;
  }

  hasConfiguredKey(provider: string): boolean {
    return this.getApiKey(provider as ModelProvider) !== undefined;
  }

  /**
   * 智谱官方 API key。视觉模型走官方端点（0ki 代理订阅不含视觉），
   * 优先读 ZHIPU_OFFICIAL_API_KEY，缺失时回落到 ZHIPU_API_KEY。
   */
  public getZhipuOfficialKey(): string | undefined {
    return normalizeApiKey(process.env.ZHIPU_OFFICIAL_API_KEY) || this.getApiKey('zhipu');
  }

  /**
   * Get API key for non-model services (Brave, Langfuse, EXA, Perplexity, SkillsMP, etc.)
   * Priority: user secure storage > cloud managed fallback > environment variable
   */
  getServiceApiKey(service: ServiceApiKey): string | undefined {
    const storage = getSecureStorage();

    // Check secure storage first
    const secureKey = storage.getApiKey(service);
    if (secureKey) return secureKey;

    const managedCloudKey = normalizeApiKey(storage.getApiKey(getCloudManagedServiceKeyId(service)));
    if (managedCloudKey) return managedCloudKey;

    // Fallback to environment variable
    const envKeyMap: Record<string, string> = {
      brave: 'BRAVE_API_KEY',
      langfuse_public: 'LANGFUSE_PUBLIC_KEY',
      langfuse_secret: 'LANGFUSE_SECRET_KEY',
      github: 'GITHUB_TOKEN',
      openrouter: 'OPENROUTER_API_KEY',
      openai: 'OPENAI_API_KEY',
      exa: 'EXA_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      tavily: 'TAVILY_API_KEY',
      skillsmp: 'SKILLSMP_API_KEY',
    };

    const envKey = envKeyMap[service];
    return envKey ? process.env[envKey] : undefined;
  }

  getServiceApiBaseUrl(service: ServiceApiKey): string | undefined {
    const storage = getSecureStorage();
    const managedCloudBaseUrl = normalizeBaseUrl(storage.get(getCloudManagedServiceBaseUrlId(service)));
    if (managedCloudBaseUrl) return managedCloudBaseUrl;

    if (service === 'openai') {
      return (
        normalizeBaseUrl(process.env.OPENAI_SEARCH_BASE_URL)
        || normalizeBaseUrl(process.env.OPENAI_API_BASE_URL)
        || normalizeBaseUrl(process.env.OPENAI_BASE_URL)
      );
    }

    return undefined;
  }

  /**
   * Set API key for non-model services
   */
  async setServiceApiKey(service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter' | 'exa' | 'perplexity' | 'skillsmp', apiKey: string): Promise<void> {
    const storage = getSecureStorage();
    storage.setApiKey(service, apiKey);
  }

  /**
   * Get integration config (e.g., Jira)
   */
  getIntegration(integration: string): Record<string, string> | null {
    const storage = getSecureStorage();
    const key = `integration.${integration}` as `integration.${string}`;
    const value = storage.get(key);
    if (value) {
      return normalizeStringRecord(parseJsonValue(value));
    }
    return null;
  }

  /**
   * Set integration config (e.g., Jira)
   */
  async setIntegration(integration: string, config: Record<string, string>): Promise<void> {
    const storage = getSecureStorage();
    const key = `integration.${integration}` as `integration.${string}`;
    storage.set(key, JSON.stringify(config));
  }

  async addRecentDirectory(dir: string): Promise<void> {
    const recent = this.settings.workspace.recentDirectories;
    const index = recent.indexOf(dir);
    if (index > -1) {
      recent.splice(index, 1);
    }
    recent.unshift(dir);
    // Keep only last 10
    this.settings.workspace.recentDirectories = recent.slice(0, 10);
    await this.save();
  }

  // Cloud Agent 配置方法
  async setCloudConfig(config: Partial<AppSettings['cloud']>): Promise<void> {
    this.settings.cloud = {
      ...this.settings.cloud,
      ...config,
    };
    await this.save();
  }

  getCloudConfig(): AppSettings['cloud'] {
    return { ...this.settings.cloud };
  }

  isCloudEnabled(): boolean {
    return this.settings.cloud.enabled && !!this.settings.cloud.endpoint;
  }

  // GUI Agent 配置方法
  async setGUIAgentConfig(config: Partial<AppSettings['guiAgent']>): Promise<void> {
    this.settings.guiAgent = {
      ...this.settings.guiAgent,
      ...config,
    };
    await this.save();
  }

  getGUIAgentConfig(): AppSettings['guiAgent'] {
    return { ...this.settings.guiAgent };
  }

  isGUIAgentEnabled(): boolean {
    return this.settings.guiAgent.enabled;
  }

  // 模型路由方法
  getModelForCapability(
    capability: 'code' | 'vision' | 'fast' | 'gui'
  ): { provider: ModelProvider; model: string } {
    return this.settings.models.routing[capability];
  }

  // Budget 配置方法
  async setBudgetConfig(config: Partial<NonNullable<AppSettings['budget']>>): Promise<void> {
    this.settings.budget = {
      enabled: config.enabled ?? this.settings.budget?.enabled ?? true,
      maxBudget: config.maxBudget ?? this.settings.budget?.maxBudget ?? 10.0,
      silentThreshold: config.silentThreshold ?? this.settings.budget?.silentThreshold ?? 0.7,
      warningThreshold: config.warningThreshold ?? this.settings.budget?.warningThreshold ?? 0.85,
      blockThreshold: config.blockThreshold ?? this.settings.budget?.blockThreshold ?? 1.0,
      resetPeriodHours: config.resetPeriodHours ?? this.settings.budget?.resetPeriodHours ?? 24,
    };
    await this.save();
  }

  getBudgetConfig(): NonNullable<AppSettings['budget']> {
    return {
      enabled: this.settings.budget?.enabled ?? true,
      maxBudget: this.settings.budget?.maxBudget ?? 10.0,
      silentThreshold: this.settings.budget?.silentThreshold ?? 0.7,
      warningThreshold: this.settings.budget?.warningThreshold ?? 0.85,
      blockThreshold: this.settings.budget?.blockThreshold ?? 1.0,
      resetPeriodHours: this.settings.budget?.resetPeriodHours ?? 24,
    };
  }

  isBudgetEnabled(): boolean {
    return this.settings.budget?.enabled ?? true;
  }

  async setModelRouting(
    capability: 'code' | 'vision' | 'fast' | 'gui',
    config: { provider: ModelProvider; model: string }
  ): Promise<void> {
    this.settings.models.routing[capability] = config;
    await this.save();
  }

  // Remove sensitive data (API keys) before saving to disk
  private sanitizeSettingsForSave(settings: AppSettings): AppSettings {
    const sanitized = JSON.parse(JSON.stringify(settings)) as AppSettings;

    // Remove API keys from provider configs (they're in SecureStorage now)
    for (const provider of Object.keys(sanitized.models.providers)) {
      const providerConfig = sanitized.models.providers[provider as ModelProvider];
      if (providerConfig?.apiKey) {
        delete providerConfig.apiKey;
      }
    }

    return sanitized;
  }

  private async save(): Promise<void> {
    try {
      // Create directory if needed
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });

      // Save config (API keys are stored in SecureStorage, not here)
      const toSave = this.sanitizeSettingsForSave(this.settings);

      await fs.writeFile(this.configPath, JSON.stringify(toSave, null, 2));
      // 标记本进程刚写过盘,让 config 热重载 watcher 忽略这次自身写入
      this.lastSelfWriteAt = Date.now();

      // Also sync key settings to Keychain for persistence across reinstalls
      await this.syncToKeychain();
    } catch (error) {
      logger.error('Failed to save config:', error);
    }
  }

  // Sync important user settings to Keychain (survives app reinstall)
  private async syncToKeychain(): Promise<void> {
    try {
      const storage = getSecureStorage();
      const settingsToSync: Record<string, unknown> = {
        // 核心配置
        modelProvider: this.settings.models.default,
        permissionMode: this.settings.permissions.permissionMode || 'default',
        devModeAutoApprove: this.settings.permissions.devModeAutoApprove,
        // UI 偏好
        language: this.settings.ui.language,
        theme: this.settings.ui.theme,
        fontSize: this.settings.ui.fontSize,
        showToolCalls: this.settings.ui.showToolCalls,
        disclosureLevel: this.settings.ui.disclosureLevel,
        // 超时配置
        timeoutComplexity: this.settings.timeouts?.complexity,
        // 模型路由
        modelRouting: this.settings.models.routing,
        // 确认门控策略
        confirmationPolicy: this.settings.confirmationGate?.policy,
      };

      // Include maxTokens if set
      const extendedSettings = this.settings as AppSettings & { maxTokens?: number };
      if (extendedSettings.maxTokens) {
        settingsToSync.maxTokens = extendedSettings.maxTokens;
      }

      await storage.saveSettingsToKeychain(settingsToSync);
    } catch (error) {
      logger.error('Failed to sync to Keychain:', error);
    }
  }

  private mergeSettings<T extends object>(base: T, updates: Partial<T>): T {
    const result = { ...base } as T;

    for (const key in updates) {
      const updateKey = key as keyof T;
      const value = updates[updateKey];
      if (value !== undefined) {
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          // 递归合并对象属性
          const baseValue = (base[updateKey] ?? {}) as object;
          const mergedValue = this.mergeSettings(baseValue, value as Partial<typeof baseValue>);
          result[updateKey] = mergedValue as T[keyof T];
        } else {
          result[updateKey] = value as T[keyof T];
        }
      }
    }

    return result;
  }
}

// Singleton accessor
let configServiceInstance: ConfigService | null = null;

export function initConfigService(): ConfigService {
  if (!configServiceInstance) {
    configServiceInstance = new ConfigService();
  }
  return configServiceInstance;
}

export function getConfigService(): ConfigService {
  if (!configServiceInstance) {
    configServiceInstance = new ConfigService();
  }
  return configServiceInstance;
}
