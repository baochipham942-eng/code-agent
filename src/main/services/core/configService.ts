// ============================================================================
// Config Service - Manage application settings
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';
import type { AppSettings, GenerationId, ModelProvider } from '../../../shared/types';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getSecureStorage } from './secureStorage';
import { createLogger } from '../infra/logger';
import { DEFAULT_GENERATION, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_MODELS } from '../../../shared/constants';

const logger = createLogger('ConfigService');

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

// Load .env file from project root or app resources
import { app as electronApp } from 'electron';

function loadEnvFile(): void {
  // Try multiple paths for .env file
  const appPath = electronApp?.getAppPath?.() || '';
  const userDataPath = electronApp?.getPath?.('userData') || '';

  // For packaged app, Resources folder is at appPath/../
  const resourcesPath = appPath ? path.join(appPath, '..') : '';

  const possiblePaths = [
    path.join(process.cwd(), '.env'),                              // Development: project root
    path.join(__dirname, '../../..', '.env'),                       // Development: relative to dist
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
logger.info('DEEPSEEK_API_KEY from env:', process.env.DEEPSEEK_API_KEY ? `${process.env.DEEPSEEK_API_KEY.substring(0, 10)}...` : 'NOT SET');

// Default settings
const DEFAULT_SETTINGS: AppSettings = {
  models: {
    default: DEFAULT_PROVIDER,  // 默认主力 provider
    providers: {
      deepseek: { enabled: true },
      claude: { enabled: false },
      openai: { enabled: false },
      gemini: { enabled: false },
      groq: { enabled: false },
      local: { enabled: false },
      zhipu: { enabled: true },     // 智谱默认启用 (视觉 + 备用语言)
      qwen: { enabled: false },
      moonshot: { enabled: true },  // Kimi K2.5 包月套餐
      minimax: { enabled: false },
      perplexity: { enabled: false },
      openrouter: { enabled: false },
    },
    // 按用途路由模型 — 引用 DEFAULT_MODELS 常量
    routing: {
      code: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.code },
      vision: { provider: 'zhipu', model: DEFAULT_MODELS.vision },
      fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
    },
  },
  generation: {
    default: DEFAULT_GENERATION,
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
};

export class ConfigService {
  private settings: AppSettings = DEFAULT_SETTINGS;
  private configPath: string;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.configPath = path.join(userDataPath, 'config.json');
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const loaded = JSON.parse(data);
      this.settings = this.mergeSettings(DEFAULT_SETTINGS, loaded);
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

    // Save merged settings
    await this.save();
  }

  // Restore user settings from Keychain (for app reinstall scenarios)
  private async restoreFromKeychain(): Promise<void> {
    try {
      const storage = getSecureStorage();
      const keychainSettings = await storage.getSettingsFromKeychain();

      if (keychainSettings) {
        logger.info('Restoring settings from Keychain:', Object.keys(keychainSettings));

        // === 核心配置 ===

        // Restore generation
        if (keychainSettings.generation && typeof keychainSettings.generation === 'string') {
          this.settings.generation.default = keychainSettings.generation as GenerationId;
        }

        // Restore model provider
        if (keychainSettings.modelProvider && typeof keychainSettings.modelProvider === 'string') {
          this.settings.models.default = keychainSettings.modelProvider as ModelProvider;
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
        if (apiKey) {
          settings.models.providers[provider as keyof typeof settings.models.providers] = {
            ...settings.models.providers[provider as keyof typeof settings.models.providers],
            apiKey,
          };
        }
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
          delete (config as Record<string, unknown>).apiKey;
        }
      }
    }

    this.settings = this.mergeSettings(this.settings, updates);
    await this.save();
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

  getApiKey(provider: ModelProvider): string | undefined {
    // Priority: secure storage > environment variable
    const storage = getSecureStorage();
    const secureKey = storage.getApiKey(provider);
    if (secureKey) return secureKey;

    // Legacy: check config.json (for migration)
    const configKey = this.settings.models.providers[provider]?.apiKey;
    if (configKey) {
      // Migrate to secure storage
      storage.setApiKey(provider, configKey);
      // Remove from config (will be saved on next settings update)
      delete this.settings.models.providers[provider]?.apiKey;
      return configKey;
    }

    // Fallback to environment variable
    const envKeyMap: Record<ModelProvider, string> = {
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
      openrouter: 'OPENROUTER_API_KEY',
    };

    const envKey = envKeyMap[provider];
    return envKey ? process.env[envKey] : undefined;
  }

  /**
   * Get API key for non-model services (Brave, Langfuse, EXA, Perplexity, SkillsMP, etc.)
   * Priority: secure storage > environment variable
   */
  getServiceApiKey(service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter' | 'exa' | 'perplexity' | 'skillsmp'): string | undefined {
    const storage = getSecureStorage();

    // Check secure storage first
    const secureKey = storage.getApiKey(service);
    if (secureKey) return secureKey;

    // Fallback to environment variable
    const envKeyMap: Record<string, string> = {
      brave: 'BRAVE_API_KEY',
      langfuse_public: 'LANGFUSE_PUBLIC_KEY',
      langfuse_secret: 'LANGFUSE_SECRET_KEY',
      github: 'GITHUB_TOKEN',
      openrouter: 'OPENROUTER_API_KEY',
      exa: 'EXA_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      skillsmp: 'SKILLSMP_API_KEY',
    };

    const envKey = envKeyMap[service];
    return envKey ? process.env[envKey] : undefined;
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
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
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

  // ============================================================================
  // 云端 API Key 同步（管理员专用）
  // ============================================================================

  /**
   * 从云端同步系统 API Key 到本地（仅管理员可用）
   * @param authToken 云端认证 token（从 GitHub OAuth 获取）
   * @returns 同步结果
   */
  async syncApiKeysFromCloud(authToken: string): Promise<{
    success: boolean;
    syncedKeys: string[];
    error?: string;
  }> {
    const cloudUrl = this.getCloudApiUrl();

    try {
      logger.info('Syncing API keys from cloud...');

      const response = await fetch(`${cloudUrl}/api/user-keys?action=sync`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        const errorMsg = errorData.error || `HTTP ${response.status}`;

        if (response.status === 403) {
          return {
            success: false,
            syncedKeys: [],
            error: '权限不足：只有管理员可以同步系统 API Key',
          };
        }

        return {
          success: false,
          syncedKeys: [],
          error: `同步失败: ${errorMsg}`,
        };
      }

      const data = await response.json() as {
        success: boolean;
        keys: Record<string, string>;
        message?: string;
      };

      if (!data.success || !data.keys) {
        return {
          success: false,
          syncedKeys: [],
          error: '服务器返回数据格式错误',
        };
      }

      // 将 Key 保存到本地安全存储
      const storage = getSecureStorage();
      const syncedKeys: string[] = [];

      for (const [keyType, keyValue] of Object.entries(data.keys)) {
        if (keyValue) {
          storage.setApiKey(keyType as ModelProvider, keyValue);
          syncedKeys.push(keyType);
          logger.info(`Synced API key: ${keyType}`);
        }
      }

      return {
        success: true,
        syncedKeys,
      };
    } catch (error: unknown) {
      const err = error as Error;
      logger.error('Failed to sync API keys from cloud', err);
      return {
        success: false,
        syncedKeys: [],
        error: `同步失败: ${err.message}`,
      };
    }
  }

  /**
   * 获取云端 API URL
   * @deprecated 使用 shared/constants 中的 getCloudApiUrl() 代替
   */
  private getCloudApiUrl(): string {
    // 引用统一常量，避免重复定义
    const { getCloudApiUrl: getUrl } = require('../../../shared/constants');
    return this.settings.cloudApi?.url || getUrl();
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
        generation: this.settings.generation.default,
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
