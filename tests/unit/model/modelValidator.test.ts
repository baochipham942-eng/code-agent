// ============================================================================
// ModelValidator 一致性测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY } from '../../../src/main/model/providerRegistry';
import {
  DEFAULT_MODELS,
  CONTEXT_WINDOWS,
  MODEL_PRICING_PER_1M,
  VISION_MODEL_CAPABILITIES,
} from '../../../src/shared/constants';

/**
 * 从 PROVIDER_REGISTRY 收集所有已注册模型 ID
 */
function collectRegisteredModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    for (const model of provider.models) {
      ids.add(model.id);
    }
  }
  return ids;
}

describe('ModelValidator — constants ↔ providerRegistry 一致性', () => {
  const registeredIds = collectRegisteredModelIds();

  it('PROVIDER_REGISTRY 应注册了至少 10 个模型', () => {
    expect(registeredIds.size).toBeGreaterThanOrEqual(10);
  });

  it('DEFAULT_MODELS 的所有模型 ID 都应在 PROVIDER_REGISTRY 中注册', () => {
    const missing: string[] = [];
    for (const [role, modelId] of Object.entries(DEFAULT_MODELS)) {
      if (!registeredIds.has(modelId)) {
        missing.push(`DEFAULT_MODELS.${role} = '${modelId}'`);
      }
    }
    expect(missing, `以下默认模型未在 Registry 注册:\n${missing.join('\n')}`).toEqual([]);
  });

  it('CONTEXT_WINDOWS 的所有模型 ID 都应在 PROVIDER_REGISTRY 中注册', () => {
    const missing: string[] = [];
    for (const modelId of Object.keys(CONTEXT_WINDOWS)) {
      if (!registeredIds.has(modelId)) {
        missing.push(modelId);
      }
    }
    expect(missing, `以下上下文窗口模型未在 Registry 注册:\n${missing.join('\n')}`).toEqual([]);
  });

  it('MODEL_PRICING_PER_1M 的所有模型 ID 都应在 PROVIDER_REGISTRY 中注册（default 除外）', () => {
    const missing: string[] = [];
    for (const modelId of Object.keys(MODEL_PRICING_PER_1M)) {
      if (modelId === 'default') continue;
      if (!registeredIds.has(modelId)) {
        missing.push(modelId);
      }
    }
    expect(missing, `以下定价模型未在 Registry 注册:\n${missing.join('\n')}`).toEqual([]);
  });

  it('VISION_MODEL_CAPABILITIES 的所有模型 ID 都应在 PROVIDER_REGISTRY 中注册', () => {
    const missing: string[] = [];
    for (const modelId of Object.keys(VISION_MODEL_CAPABILITIES)) {
      if (!registeredIds.has(modelId)) {
        missing.push(modelId);
      }
    }
    expect(missing, `以下视觉模型未在 Registry 注册:\n${missing.join('\n')}`).toEqual([]);
  });

  it('不应包含已废弃的模型名', () => {
    const deprecated = ['glm-4-flash', 'glm-4v-plus', 'glm-4v-flash', 'glm-4-plus'];
    const found: string[] = [];
    for (const id of registeredIds) {
      if (deprecated.includes(id)) {
        found.push(id);
      }
    }
    expect(found, `PROVIDER_REGISTRY 中包含已废弃模型:\n${found.join('\n')}`).toEqual([]);
  });
});
