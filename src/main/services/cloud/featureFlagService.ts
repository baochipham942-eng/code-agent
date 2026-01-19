// ============================================================================
// Feature Flag Service - 功能开关管理
// ============================================================================
// 从 CloudConfigService 读取 Feature Flags，提供便捷的检查接口

import { getCloudConfigService, type FeatureFlags } from './cloudConfigService';

// ----------------------------------------------------------------------------
// FeatureFlagService
// ----------------------------------------------------------------------------

class FeatureFlagService {
  /**
   * 获取所有 Feature Flags
   */
  getAll(): FeatureFlags {
    return getCloudConfigService().getFeatureFlags();
  }

  /**
   * 获取特定 Flag 的值
   */
  get<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
    return getCloudConfigService().getFeatureFlag(key);
  }

  /**
   * 检查 Gen8 是否启用
   */
  isGen8Enabled(): boolean {
    return this.get('enableGen8');
  }

  /**
   * 检查云端 Agent 是否启用
   */
  isCloudAgentEnabled(): boolean {
    return this.get('enableCloudAgent');
  }

  /**
   * 检查记忆系统是否启用
   */
  isMemoryEnabled(): boolean {
    return this.get('enableMemory');
  }

  /**
   * 检查 Computer Use 是否启用
   */
  isComputerUseEnabled(): boolean {
    return this.get('enableComputerUse');
  }

  /**
   * 获取最大迭代次数
   */
  getMaxIterations(): number {
    return this.get('maxIterations');
  }

  /**
   * 获取最大消息长度
   */
  getMaxMessageLength(): number {
    return this.get('maxMessageLength');
  }

  /**
   * 检查实验性工具是否启用
   */
  isExperimentalToolsEnabled(): boolean {
    return this.get('enableExperimentalTools');
  }

  /**
   * 检查功能是否启用（通用方法）
   */
  isEnabled(feature: keyof FeatureFlags): boolean {
    const value = this.get(feature);
    return typeof value === 'boolean' ? value : false;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let instance: FeatureFlagService | null = null;

export function getFeatureFlagService(): FeatureFlagService {
  if (!instance) {
    instance = new FeatureFlagService();
  }
  return instance;
}

// 便捷函数导出
export const isGen8Enabled = () => getFeatureFlagService().isGen8Enabled();
export const isCloudAgentEnabled = () => getFeatureFlagService().isCloudAgentEnabled();
export const isMemoryEnabled = () => getFeatureFlagService().isMemoryEnabled();
export const isComputerUseEnabled = () => getFeatureFlagService().isComputerUseEnabled();
export const getMaxIterations = () => getFeatureFlagService().getMaxIterations();
export const getMaxMessageLength = () => getFeatureFlagService().getMaxMessageLength();
export const isExperimentalToolsEnabled = () => getFeatureFlagService().isExperimentalToolsEnabled();
