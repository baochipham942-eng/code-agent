// ============================================================================
// 模型「已验证工具调用 / 未验证自担风险」二分（D-3）
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  AGENT_DEFAULT_MODEL,
  DEFAULT_MODELS,
  isAgenticVerifiedModel,
  PROVIDER_MODELS,
  VERIFIED_AGENTIC_MODELS,
} from '../../../src/shared/constants';
import { partitionByAgenticVerified } from '../../../src/renderer/components/features/settings/tabs/ProviderModelsSection';
import type { RuntimeProviderModel } from '../../../src/shared/modelRuntime';

function model(id: string): RuntimeProviderModel {
  return {
    id,
    label: id,
    enabled: true,
    capabilities: [],
    supportsTool: true,
    supportsVision: false,
    supportsStreaming: true,
    source: 'catalog',
  };
}

describe('VERIFIED_AGENTIC_MODELS', () => {
  it('覆盖出厂在跑的主链路默认模型', () => {
    for (const id of [
      DEFAULT_MODELS.chat,
      DEFAULT_MODELS.code,
      DEFAULT_MODELS.compact,
      DEFAULT_MODELS.reasoning,
      AGENT_DEFAULT_MODEL.model,
    ]) {
      expect(isAgenticVerifiedModel(id)).toBe(true);
    }
  });

  it('刻意保持小：远少于 catalog 全量模型', () => {
    const catalogModelCount = PROVIDER_MODELS.reduce((sum, provider) => sum + provider.models.length, 0);
    expect(VERIFIED_AGENTIC_MODELS.size).toBeGreaterThan(0);
    expect(VERIFIED_AGENTIC_MODELS.size).toBeLessThan(catalogModelCount / 2);
  });

  it('没验过的自造模型 id 一律算未验证', () => {
    expect(isAgenticVerifiedModel('my-local-llm-v0')).toBe(false);
    expect(isAgenticVerifiedModel('custom-model')).toBe(false);
  });

  it('带 provider 前缀的 id 归一化后仍认得出', () => {
    const prefixed = `openrouter/${DEFAULT_MODELS.reasoning}`;
    expect(VERIFIED_AGENTIC_MODELS.has(prefixed)).toBe(false);
    expect(isAgenticVerifiedModel(prefixed)).toBe(true);
  });

  it('视觉/快判档不当作工具调用证据', () => {
    expect(isAgenticVerifiedModel(DEFAULT_MODELS.vision)).toBe(false);
    expect(isAgenticVerifiedModel(DEFAULT_MODELS.quick)).toBe(false);
  });
});

describe('partitionByAgenticVerified', () => {
  it('已验证的留在主列表，未验证的折进高级', () => {
    const { verified, unverified } = partitionByAgenticVerified([
      model(DEFAULT_MODELS.chat),
      model('my-local-llm-v0'),
      model(AGENT_DEFAULT_MODEL.model),
    ]);
    expect(verified.map((item) => item.id)).toEqual([DEFAULT_MODELS.chat, AGENT_DEFAULT_MODEL.model]);
    expect(unverified.map((item) => item.id)).toEqual(['my-local-llm-v0']);
  });

  it('不丢模型：两边加起来等于原列表', () => {
    const models = [model(DEFAULT_MODELS.chat), model('x'), model('y'), model(DEFAULT_MODELS.compact)];
    const { verified, unverified } = partitionByAgenticVerified(models);
    expect(verified.length + unverified.length).toBe(models.length);
  });
});
