// ============================================================================
// Cloud Config Service - 云端配置管理
// ============================================================================
// 负责从云端拉取配置、缓存管理、离线降级

import type { GenerationId, SkillDefinition } from '../../../shared/types';
import { getBuiltinConfig, type CloudConfig, type ToolMetadata, type FeatureFlags } from './builtinConfig';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const CLOUD_CONFIG_URL = 'https://code-agent-beta.vercel.app/api/v1/config';
const CACHE_TTL = 3600000; // 1 小时
const FETCH_TIMEOUT = 5000; // 5 秒

// ----------------------------------------------------------------------------
// CloudConfigService
// ----------------------------------------------------------------------------

class CloudConfigService {
  private cache: CloudConfig | null = null;
  private cacheExpiry: number = 0;
  private etag: string | null = null;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private lastError: string | null = null;

  /**
   * 初始化服务 - 异步拉取云端配置
   * 不阻塞窗口创建，失败时静默降级到内置配置
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      console.log('[CloudConfig] Initializing...');
      await this.fetchConfig();
      this.isInitialized = true;
      console.log(`[CloudConfig] Initialized with cloud config v${this.cache?.version}`);
    } catch (error) {
      // 静默降级到内置配置
      console.warn('[CloudConfig] Failed to fetch cloud config, using builtin:', error);
      this.cache = getBuiltinConfig();
      this.cacheExpiry = Date.now() + CACHE_TTL;
      this.isInitialized = true;
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  /**
   * 手动刷新配置
   */
  async refresh(): Promise<{ success: boolean; version: string; error?: string }> {
    try {
      await this.fetchConfig();
      this.lastError = null;
      return {
        success: true,
        version: this.cache?.version || 'unknown',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.lastError = errorMsg;
      return {
        success: false,
        version: this.cache?.version || 'unknown',
        error: errorMsg,
      };
    }
  }

  /**
   * 获取配置 - 优先返回缓存
   */
  getConfig(): CloudConfig {
    // 如果缓存有效，直接返回
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    // 缓存过期但有数据，返回旧数据并异步刷新
    if (this.cache) {
      this.fetchConfig().catch(console.warn);
      return this.cache;
    }

    // 没有缓存，返回内置配置
    return getBuiltinConfig();
  }

  /**
   * 获取指定代际的 System Prompt
   */
  getPrompt(genId: GenerationId): string {
    const config = this.getConfig();
    return config.prompts[genId] || '';
  }

  /**
   * 获取所有 Skills
   */
  getSkills(): SkillDefinition[] {
    const config = this.getConfig();
    return config.skills;
  }

  /**
   * 获取指定 Skill
   */
  getSkill(name: string): SkillDefinition | undefined {
    const skills = this.getSkills();
    return skills.find(s => s.name === name);
  }

  /**
   * 获取工具元数据
   */
  getToolMeta(name: string): ToolMetadata | undefined {
    const config = this.getConfig();
    return config.toolMeta[name];
  }

  /**
   * 获取所有工具元数据
   */
  getAllToolMeta(): Record<string, ToolMetadata> {
    const config = this.getConfig();
    return config.toolMeta;
  }

  /**
   * 获取 Feature Flags
   */
  getFeatureFlags(): FeatureFlags {
    const config = this.getConfig();
    return config.featureFlags;
  }

  /**
   * 获取特定 Feature Flag
   */
  getFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
    const flags = this.getFeatureFlags();
    return flags[key];
  }

  /**
   * 获取 UI 字符串
   */
  getUIString(key: string, lang: 'zh' | 'en' = 'zh'): string {
    const config = this.getConfig();
    return config.uiStrings[lang]?.[key] || key;
  }

  /**
   * 获取所有 UI 字符串
   */
  getUIStrings(lang: 'zh' | 'en' = 'zh'): Record<string, string> {
    const config = this.getConfig();
    return config.uiStrings[lang] || {};
  }

  /**
   * 获取规则
   */
  getRule(name: string): string {
    const config = this.getConfig();
    return config.rules[name] || '';
  }

  /**
   * 获取配置信息
   */
  getInfo(): {
    version: string;
    isCloud: boolean;
    cacheExpiry: number;
    lastError: string | null;
  } {
    const config = this.getConfig();
    const builtinVersion = getBuiltinConfig().version;
    return {
      version: config.version,
      isCloud: config.version !== builtinVersion || this.etag !== null,
      cacheExpiry: this.cacheExpiry,
      lastError: this.lastError,
    };
  }

  /**
   * 从云端拉取配置
   */
  private async fetchConfig(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // 如果有 ETag，发送 If-None-Match 头
      if (this.etag) {
        headers['If-None-Match'] = this.etag;
      }

      const response = await fetch(CLOUD_CONFIG_URL, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      // 304 Not Modified - 使用缓存
      if (response.status === 304) {
        console.log('[CloudConfig] Config unchanged (304)');
        this.cacheExpiry = Date.now() + CACHE_TTL;
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const config = await response.json() as CloudConfig;

      // 验证配置结构
      if (!config.version || !config.prompts) {
        throw new Error('Invalid config structure');
      }

      // 更新缓存
      this.cache = config;
      this.cacheExpiry = Date.now() + CACHE_TTL;
      this.etag = response.headers.get('ETag');

      console.log(`[CloudConfig] Fetched config v${config.version}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let instance: CloudConfigService | null = null;

export function getCloudConfigService(): CloudConfigService {
  if (!instance) {
    instance = new CloudConfigService();
  }
  return instance;
}

/**
 * 初始化云端配置服务
 * 应在应用启动时调用，但不阻塞窗口创建
 */
export async function initCloudConfigService(): Promise<void> {
  const service = getCloudConfigService();
  return service.initialize();
}

/**
 * 刷新云端配置
 */
export async function refreshCloudConfig(): Promise<{ success: boolean; version: string; error?: string }> {
  const service = getCloudConfigService();
  return service.refresh();
}

// 导出类型
export type { CloudConfig, ToolMetadata, FeatureFlags };
