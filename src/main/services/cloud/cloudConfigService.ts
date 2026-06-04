// ============================================================================
// Cloud Config Service - 云端配置管理
// ============================================================================
// 负责从云端拉取配置、缓存管理、离线降级

import type { SkillDefinition } from '../../../shared/contract';
import {
  getBuiltinConfig,
  type CloudConfig,
  type ToolMetadata,
  type FeatureFlags,
  type MCPServerCloudConfig,
  type EntitlementPolicy,
  type KillSwitchPolicy,
  type ReleasePolicy,
  type ModelRoutingConfig,
} from './builtinConfig';
import { setModelRoutingOverride } from '../../model/modelRouterPolicy';
import { createLogger } from '../infra/logger';
import { CACHE, CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import {
  getBuiltinSkillCatalogPayload,
} from '../../../shared/constants/skillCatalog';
import {
  getBuiltinMcpCatalogPayload,
} from '../../../shared/constants/mcpCatalog';
import type { SkillCatalogPayload } from '../../../shared/contract/skillRepository';
import type { McpCatalogPayload } from '../../../shared/contract/mcpCatalog';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from './controlPlaneTrust';
import type { ControlPlaneDiagnostic } from '../../../shared/contract/controlPlane';

const logger = createLogger('CloudConfigService');

const FEATURE_ENTITLEMENT_CAPABILITY: Partial<Record<keyof FeatureFlags, string>> = {
  enableCloudAgent: 'cloud_agent',
  enableMemory: 'memory',
  enableComputerUse: 'computer_use',
  enableExperimentalTools: 'experimental_tools',
};

const CLOUD_MCP_ENTITLEMENT_CAPABILITIES = ['mcp_cloud', 'mcp_server'] as const;
const CLOUD_MCP_KILL_SWITCH_FEATURES = [
  'mcp_cloud',
  'mcp_server',
  'cloud_mcp',
  'cloud_mcp_servers',
  'mcpServers',
  'enableCloudAgent',
] as const;

export interface CloudConfigServiceOptions {
  getAccessToken?: () => Promise<string | null>;
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  allowUnsignedCloudConfig?: boolean;
}

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
  private lastTrustDiagnostics: ControlPlaneDiagnostic[] = [];
  private lastTrust: { trusted: boolean; keyId?: string; expiresAt?: string } = { trusted: false };
  private options: CloudConfigServiceOptions = {};

  constructor(options: CloudConfigServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: CloudConfigServiceOptions): void {
    this.options = {
      ...this.options,
      ...options,
    };
  }

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
      // builtin 无 modelRouting → 清空 override，路由降级硬编码
      setModelRoutingOverride(this.cache.modelRouting);
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
   * 获取 Skill 推荐目录
   * 云端下发优先；数据缺失或不完整时降级到内置目录
   */
  getSkillCatalog(): SkillCatalogPayload {
    const catalog = this.getConfig().skillCatalog;
    if (catalog?.categories?.length && catalog?.skills?.length) {
      return catalog;
    }
    return getBuiltinSkillCatalogPayload();
  }

  /**
   * 获取 MCP 推荐目录
   * 云端下发优先；数据缺失或不完整时降级到内置目录
   */
  getMcpCatalog(): McpCatalogPayload {
    const catalog = this.getConfig().mcpCatalog;
    if (catalog?.categories?.length && catalog?.servers?.length) {
      return catalog;
    }
    return getBuiltinMcpCatalogPayload();
  }

  getEntitlement(): EntitlementPolicy {
    return this.getConfig().entitlement ?? getBuiltinConfig().entitlement!;
  }

  getKillSwitches(): KillSwitchPolicy {
    return this.getConfig().killSwitches ?? getBuiltinConfig().killSwitches!;
  }

  getReleasePolicy(): ReleasePolicy {
    return this.getConfig().release ?? getBuiltinConfig().release!;
  }

  getModelRouting(): ModelRoutingConfig | undefined {
    return this.getConfig().modelRouting;
  }

  isGlobalKillSwitchActive(): boolean {
    return this.getKillSwitches().global?.disabled === true;
  }

  isFeatureDisabledByPolicy(feature: keyof FeatureFlags | string): boolean {
    if (this.isGlobalKillSwitchActive()) return true;

    const featureSwitch = this.getKillSwitches().features?.[feature];
    if (featureSwitch?.disabled === true) return true;

    const capability = FEATURE_ENTITLEMENT_CAPABILITY[feature as keyof FeatureFlags];
    if (!capability) return false;

    const entitlement = this.getEntitlement();
    if (entitlement.status === 'expired' || entitlement.status === 'revoked') return true;
    if (entitlement.capabilities.includes('*')) return false;
    return !entitlement.capabilities.includes(capability);
  }

  getCloudMCPServerPolicyBlockReason(): string | null {
    if (this.isGlobalKillSwitchActive()) {
      return 'global_kill_switch';
    }

    const featureSwitches = this.getKillSwitches().features ?? {};
    for (const feature of CLOUD_MCP_KILL_SWITCH_FEATURES) {
      if (featureSwitches[feature]?.disabled === true) {
        return `feature_kill_switch:${feature}`;
      }
    }

    const entitlement = this.getConfig().entitlement;
    if (!entitlement) {
      return 'missing_entitlement:mcp_cloud';
    }

    if (entitlement.status === 'expired' || entitlement.status === 'revoked') {
      return `entitlement_${entitlement.status}`;
    }

    if (entitlement.capabilities.includes('*')) {
      return null;
    }

    const hasCloudMcpCapability = CLOUD_MCP_ENTITLEMENT_CAPABILITIES.some((capability) =>
      entitlement.capabilities.includes(capability),
    );
    return hasCloudMcpCapability ? null : 'missing_entitlement:mcp_cloud';
  }

  isCloudMCPServersEnabledByPolicy(): boolean {
    return this.getCloudMCPServerPolicyBlockReason() === null;
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
    trust: {
      trusted: boolean;
      keyId?: string;
      expiresAt?: string;
      diagnostics: ControlPlaneDiagnostic[];
    };
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
      trust: {
        trusted: this.lastTrust.trusted,
        ...(this.lastTrust.keyId ? { keyId: this.lastTrust.keyId } : {}),
        ...(this.lastTrust.expiresAt ? { expiresAt: this.lastTrust.expiresAt } : {}),
        diagnostics: this.lastTrustDiagnostics,
      },
    };
  }

  private getPublicKeys(): ControlPlanePublicKeys {
    return this.options.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
  }

  private allowUnsignedCloudConfig(): boolean {
    return this.options.allowUnsignedCloudConfig === true
      || process.env.CODE_AGENT_ALLOW_UNSIGNED_CLOUD_CONFIG === '1';
  }

  private acceptFetchedConfig(value: unknown): CloudConfig {
    if (isControlPlaneEnvelope(value)) {
      const trust = verifyControlPlaneEnvelope<CloudConfig>(value, {
        kind: 'cloud_config',
        publicKeys: this.getPublicKeys(),
        requireSignature: !this.allowUnsignedCloudConfig(),
        allowUnsigned: this.allowUnsignedCloudConfig(),
      });
      this.lastTrustDiagnostics = trust.diagnostics;
      this.lastTrust = {
        trusted: trust.trusted,
        ...(trust.keyId ? { keyId: trust.keyId } : {}),
        ...(trust.expiresAt ? { expiresAt: trust.expiresAt } : {}),
      };
      if (!trust.trusted || !trust.payload) {
        throw new Error(`Rejected untrusted cloud config: ${trust.diagnostics.map((entry) => entry.code).join(', ')}`);
      }
      return trust.payload;
    }

    if (this.allowUnsignedCloudConfig()) {
      this.lastTrustDiagnostics = [{
        severity: 'warning',
        code: 'unsigned_cloud_config_allowed',
        message: 'Unsigned cloud config was accepted because CODE_AGENT_ALLOW_UNSIGNED_CLOUD_CONFIG is enabled.',
      }];
      this.lastTrust = { trusted: false };
      logger.warn('Accepting unsigned cloud config because unsigned override is enabled');
      return value as CloudConfig;
    }

    this.lastTrustDiagnostics = [{
      severity: 'error',
      code: 'missing_control_plane_envelope',
      message: 'Cloud config responses must be signed control-plane envelopes.',
    }];
    this.lastTrust = { trusted: false };
    throw new Error('Rejected unsigned cloud config response');
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

      const accessToken = await this.options.getAccessToken?.().catch((error) => {
        logger.warn('Failed to read cloud config access token', { error: String(error) });
        return null;
      });
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const response = await fetch(CLOUD_ENDPOINTS.config, {
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

      const config = this.acceptFetchedConfig(await response.json());

      // 验证配置结构
      if (!config.version || !config.prompts) {
        throw new Error('Invalid config structure');
      }

      // 更新缓存
      this.cache = config;
      this.cacheExpiry = Date.now() + CACHE.CONFIG_TTL;
      this.etag = response.headers.get('ETag');
      // 同步模型路由 override（缺省/畸形会在 setter 内降级硬编码 PROVIDER_FALLBACK_CHAIN）
      setModelRoutingOverride(config.modelRouting);

      logger.info(`Fetched trusted config v${config.version}`, {
        expiresAt: this.lastTrust.expiresAt || 'not set',
        keyId: this.lastTrust.keyId || 'not set',
      });
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
export async function initCloudConfigService(options?: CloudConfigServiceOptions): Promise<void> {
  const service = getCloudConfigService();
  if (options) {
    service.setOptions(options);
  }
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
export type {
  CloudConfig,
  ToolMetadata,
  FeatureFlags,
  MCPServerCloudConfig,
  EntitlementPolicy,
  KillSwitchPolicy,
  ReleasePolicy,
};
