// ============================================================================
// Cloud Config Service - 云端配置管理
// ============================================================================
// 负责从云端拉取配置、缓存管理、离线降级

import type { GenerationId, SkillDefinition } from '../../../shared/types';
import { getBuiltinConfig, type CloudConfig, type ToolMetadata, type FeatureFlags, type MCPServerCloudConfig } from './builtinConfig';
import { createLogger } from '../infra/logger';
import { CACHE, CLOUD } from '../../../shared/constants';

const logger = createLogger('CloudConfigService');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const CLOUD_CONFIG_URL = 'https://code-agent-beta.vercel.app/api/v1/config';

// ----------------------------------------------------------------------------
// CloudConfigService
// ----------------------------------------------------------------------------

/**
 * Cloud Config Service - 云端配置管理服务
 *
 * 负责从云端拉取和管理配置，支持：
 * - System Prompt 热更新
 * - Skill 定义热更新
 * - Tool 元数据热更新
 * - Feature Flags 管理
 * - MCP Server 配置
 *
 * 缓存策略：
 * - 默认 TTL：1 小时
 * - 支持 ETag（304 Not Modified）
 * - 离线时降级到内置配置
 *
 * @example
 * ```typescript
 * const service = getCloudConfigService();
 * await service.initialize();
 *
 * const prompt = service.getPrompt('gen4');
 * const skills = service.getSkills();
 * ```
 *
 * @see FeatureFlagService - Feature Flag 便捷接口
 */
export class CloudConfigService {
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
      logger.info(' Initializing...');
      await this.fetchConfig();
      this.isInitialized = true;
      logger.info(`Initialized with cloud config v${this.cache?.version}`);
    } catch (error) {
      // 静默降级到内置配置
      logger.warn(' Failed to fetch cloud config, using builtin:', error);
      this.cache = getBuiltinConfig();
      this.cacheExpiry = Date.now() + CACHE.CONFIG_TTL;
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
      this.fetchConfig().catch((err) => logger.warn('Failed to refresh config:', err));
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
   * 获取 MCP Servers 配置
   */
  getMCPServers(): MCPServerCloudConfig[] {
    const config = this.getConfig();
    return config.mcpServers || [];
  }

  /**
   * 获取指定 MCP Server 配置
   */
  getMCPServer(id: string): MCPServerCloudConfig | undefined {
    const servers = this.getMCPServers();
    return servers.find(s => s.id === id);
  }

  /**
   * 获取配置信息
   */
  getInfo(): {
    version: string;
    lastFetch: number;
    isStale: boolean;
    fromCloud: boolean;
    lastError: string | null;
  } {
    const config = this.getConfig();
    const builtinVersion = getBuiltinConfig().version;
    const isStale = Date.now() > this.cacheExpiry;
    const fromCloud = config.version !== builtinVersion || this.etag !== null;

    return {
      version: config.version,
      lastFetch: this.cacheExpiry > 0 ? this.cacheExpiry - CACHE.CONFIG_TTL : 0,
      isStale,
      fromCloud,
      lastError: this.lastError,
    };
  }

  /**
   * 从云端拉取配置
   */
  private async fetchConfig(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);

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
        logger.info(' Config unchanged (304)');
        this.cacheExpiry = Date.now() + CACHE.CONFIG_TTL;
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
      this.cacheExpiry = Date.now() + CACHE.CONFIG_TTL;
      this.etag = response.headers.get('ETag');

      logger.info(`Fetched config v${config.version}`);
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
export type { CloudConfig, ToolMetadata, FeatureFlags, MCPServerCloudConfig };
