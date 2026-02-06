// ============================================================================
// Model Session State - 运行时模型热切换
// ============================================================================
//
// 管理每个会话的模型覆盖配置。
// 用户可在对话中途切换模型，下一轮生效。

import { createLogger } from '../services/infra/logger';
import type { ModelProvider } from '../../shared/types/model';

const logger = createLogger('ModelSessionState');

export interface ModelOverride {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  setAt: number;
}

export class ModelSessionState {
  private overrides = new Map<string, ModelOverride>();

  /**
   * 设置 session 的模型覆盖
   */
  setOverride(sessionId: string, override: Omit<ModelOverride, 'setAt'>): void {
    const fullOverride: ModelOverride = {
      ...override,
      setAt: Date.now(),
    };
    this.overrides.set(sessionId, fullOverride);
    logger.info('Model override set', {
      sessionId,
      provider: override.provider,
      model: override.model,
    });
  }

  /**
   * 获取 session 的模型覆盖
   */
  getOverride(sessionId: string): ModelOverride | null {
    return this.overrides.get(sessionId) || null;
  }

  /**
   * 获取生效配置：优先使用 session override，否则使用 baseConfig
   */
  getEffectiveConfig(
    sessionId: string,
    baseConfig: { provider: ModelProvider; model: string; temperature?: number; maxTokens?: number }
  ): { provider: ModelProvider; model: string; temperature?: number; maxTokens?: number } {
    const override = this.overrides.get(sessionId);
    if (!override) return baseConfig;

    return {
      provider: override.provider,
      model: override.model,
      temperature: override.temperature ?? baseConfig.temperature,
      maxTokens: override.maxTokens ?? baseConfig.maxTokens,
    };
  }

  /**
   * 清除 session 的模型覆盖
   */
  clearOverride(sessionId: string): void {
    this.overrides.delete(sessionId);
  }

  /**
   * 获取所有活跃的覆盖
   */
  getAllOverrides(): Map<string, ModelOverride> {
    return new Map(this.overrides);
  }

  /**
   * 清除所有覆盖
   */
  clearAll(): void {
    this.overrides.clear();
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ModelSessionState | null = null;

export function getModelSessionState(): ModelSessionState {
  if (!instance) {
    instance = new ModelSessionState();
  }
  return instance;
}

export function resetModelSessionState(): void {
  instance = null;
}
