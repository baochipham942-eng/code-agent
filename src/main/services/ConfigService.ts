// ============================================================================
// Config Service - Manage application settings
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';
import type { AppSettings, GenerationId, ModelProvider } from '../../shared/types';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getSecureStorage } from './SecureStorage';

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

  console.log('[ConfigService] Trying .env paths:');
  for (const envPath of possiblePaths) {
    console.log('[ConfigService]   -', envPath);
    try {
      const result = dotenv.config({ path: envPath });
      if (!result.error) {
        console.log('[ConfigService] ✓ Loaded .env from:', envPath);
        return;
      }
    } catch (e) {
      // Continue to next path
    }
  }
  console.log('[ConfigService] ✗ No .env file found, using environment variables only');
}

loadEnvFile();
console.log('[ConfigService] SUPABASE_URL from env:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
console.log('[ConfigService] DEEPSEEK_API_KEY from env:', process.env.DEEPSEEK_API_KEY ? `${process.env.DEEPSEEK_API_KEY.substring(0, 10)}...` : 'NOT SET');

// Default settings
const DEFAULT_SETTINGS: AppSettings = {
  models: {
    default: 'deepseek',
    providers: {
      deepseek: { enabled: true },
      claude: { enabled: false },
      openai: { enabled: false },
      groq: { enabled: false },
      local: { enabled: false },
      zhipu: { enabled: true },     // 智谱默认启用 (视觉 + 备用语言)
      qwen: { enabled: false },
      moonshot: { enabled: false },
      perplexity: { enabled: false },
    },
    // 按用途路由模型
    routing: {
      code: { provider: 'deepseek', model: 'deepseek-coder' },        // 代码专用
      vision: { provider: 'zhipu', model: 'glm-4v-plus' },            // 智谱视觉
      fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },   // 快速推理
      gui: { provider: 'zhipu', model: 'glm-4v-plus' },               // GUI Agent 用智谱视觉
    },
  },
  generation: {
    default: 'gen3' as GenerationId,
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
    devModeAutoApprove: true, // Default to true for development convenience
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
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to load config:', error);
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
        console.log('[ConfigService] Restoring settings from Keychain:', Object.keys(keychainSettings));

        // Restore generation
        if (keychainSettings.generation && typeof keychainSettings.generation === 'string') {
          this.settings.generation.default = keychainSettings.generation as GenerationId;
        }

        // Restore model settings
        if (keychainSettings.modelProvider && typeof keychainSettings.modelProvider === 'string') {
          this.settings.models.default = keychainSettings.modelProvider as ModelProvider;
        }

        // Restore language
        if (keychainSettings.language && typeof keychainSettings.language === 'string') {
          this.settings.ui.language = keychainSettings.language;
        }

        // Restore devModeAutoApprove
        if (typeof keychainSettings.devModeAutoApprove === 'boolean') {
          this.settings.permissions.devModeAutoApprove = keychainSettings.devModeAutoApprove;
        }

        // Restore disclosureLevel
        if (keychainSettings.disclosureLevel && typeof keychainSettings.disclosureLevel === 'string') {
          const validLevels = ['simple', 'standard', 'advanced', 'expert'];
          if (validLevels.includes(keychainSettings.disclosureLevel)) {
            this.settings.ui.disclosureLevel = keychainSettings.disclosureLevel as 'simple' | 'standard' | 'advanced' | 'expert';
          }
        }

        // Restore maxTokens
        if (typeof keychainSettings.maxTokens === 'number') {
          // Store maxTokens for use when needed (not in default settings structure)
          (this.settings as any).maxTokens = keychainSettings.maxTokens;
        }
      }
    } catch (error) {
      console.error('[ConfigService] Failed to restore from Keychain:', error);
    }
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<void> {
    this.settings = this.mergeSettings(this.settings, updates);
    await this.save();
  }

  async setApiKey(provider: ModelProvider, apiKey: string): Promise<void> {
    this.settings.models.providers[provider] = {
      ...this.settings.models.providers[provider],
      apiKey,
      enabled: true,
    };
    await this.save();
  }

  getApiKey(provider: ModelProvider): string | undefined {
    // Priority: config.json > environment variable
    const configKey = this.settings.models.providers[provider]?.apiKey;
    if (configKey) return configKey;

    // Fallback to environment variable
    const envKeyMap: Record<ModelProvider, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      claude: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      groq: 'GROQ_API_KEY',
      local: '',
      zhipu: 'ZHIPU_API_KEY',
      qwen: 'QWEN_API_KEY',
      moonshot: 'MOONSHOT_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
    };

    const envKey = envKeyMap[provider];
    return envKey ? process.env[envKey] : undefined;
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

  async setModelRouting(
    capability: 'code' | 'vision' | 'fast' | 'gui',
    config: { provider: ModelProvider; model: string }
  ): Promise<void> {
    this.settings.models.routing[capability] = config;
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      // Create directory if needed
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });

      // Save config (excluding sensitive data in plaintext)
      const toSave = {
        ...this.settings,
        // TODO: Encrypt API keys before saving
      };

      await fs.writeFile(this.configPath, JSON.stringify(toSave, null, 2));

      // Also sync key settings to Keychain for persistence across reinstalls
      await this.syncToKeychain();
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  // Sync important user settings to Keychain (survives app reinstall)
  private async syncToKeychain(): Promise<void> {
    try {
      const storage = getSecureStorage();
      const settingsToSync: Record<string, unknown> = {
        generation: this.settings.generation.default,
        modelProvider: this.settings.models.default,
        language: this.settings.ui.language,
        disclosureLevel: this.settings.ui.disclosureLevel,
        devModeAutoApprove: this.settings.permissions.devModeAutoApprove,
      };

      // Include maxTokens if set
      if ((this.settings as any).maxTokens) {
        settingsToSync.maxTokens = (this.settings as any).maxTokens;
      }

      await storage.saveSettingsToKeychain(settingsToSync);
    } catch (error) {
      console.error('[ConfigService] Failed to sync to Keychain:', error);
    }
  }

  private mergeSettings<T extends object>(base: T, updates: Partial<T>): T {
    const result = { ...base };

    for (const key in updates) {
      const value = updates[key];
      if (value !== undefined) {
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          (result as any)[key] = this.mergeSettings(
            (base as any)[key] || {},
            value as any
          );
        } else {
          (result as any)[key] = value;
        }
      }
    }

    return result;
  }
}
