// N-MODELCAT-SERVICE-TIER-WIRE：service_tier 纯解析（resolveServiceTier）与
// run 接缝（applyRunServiceTier）。档位值 / 拒绝信号集单一源在 shared/constants/serviceTier。
import { describe, expect, it } from 'vitest';

import { resolveServiceTier, withServiceTier, applyRunServiceTier } from '../../../src/host/agent/serviceTier';
import { normalizeSubagentModelContext } from '../../../src/host/agent/subagentProtocolContext';
import { UNATTENDED_SERVICE_TIER } from '../../../src/shared/constants';
import type { ModelConfig } from '../../../src/shared/contract';

const config = (overrides: Partial<ModelConfig>): ModelConfig => ({ provider: 'openai', model: 'gpt-6.1-sol', ...overrides });

describe('resolveServiceTier（纯解析）', () => {
  it("scope 'unattended' → 半价档常量", () => {
    expect(resolveServiceTier('unattended')).toBe(UNATTENDED_SERVICE_TIER);
  });

  it("scope 'default'（前台 run）→ 无档（字段缺席 = standard）", () => {
    expect(resolveServiceTier('default')).toBeUndefined();
  });

  it('子代理（parentTier 给定）继承根会话的档位，即使自身 scope 不是 unattended', () => {
    expect(resolveServiceTier('default', 'flex')).toBe('flex');
  });

  it('评审（isReview）强制 standard：parentTier 在场也摘掉', () => {
    expect(resolveServiceTier('unattended', 'flex', true)).toBeUndefined();
  });
});

describe('applyRunServiceTier（run 接缝）', () => {
  it('无人值守 + openai → 挂半价档', () => {
    expect(applyRunServiceTier(config({}), true)).toMatchObject({ serviceTier: UNATTENDED_SERVICE_TIER });
  });

  it('前台 + openai → 无档，且字段不在场', () => {
    const resolved = applyRunServiceTier(config({}), false);
    expect(resolved.serviceTier).toBeUndefined();
    expect('serviceTier' in resolved).toBe(false);
  });

  it('无人值守但非 openai（deepseek 走 Responses）→ 请求字节必须不变：无档', () => {
    const resolved = applyRunServiceTier(config({ provider: 'deepseek', model: 'deepseek-v4-flash' }), true);
    expect(resolved.serviceTier).toBeUndefined();
    expect('serviceTier' in resolved).toBe(false);
  });

  it('非 openai 即使被上游塞了档也摘掉（兜底，保证字节不变）', () => {
    const resolved = applyRunServiceTier(config({ provider: 'deepseek', model: 'deepseek-v4-flash', serviceTier: 'flex' }), true);
    expect('serviceTier' in resolved).toBe(false);
  });
});

describe('withServiceTier（字段重写）', () => {
  it('摘档后字段不在场（不是 undefined 在场）', () => {
    const stripped = withServiceTier(config({ serviceTier: 'flex' }), undefined);
    expect('serviceTier' in stripped).toBe(false);
  });

  it('档位不变时原对象直通（不复制）', () => {
    const original = config({ serviceTier: 'flex' });
    expect(withServiceTier(original, 'flex')).toBe(original);
  });
});

describe('子代理继承（config 按展开复制）', () => {
  it('normalizeSubagentModelContext 的 resolveModelDecision 展开路径保留 serviceTier 字段', () => {
    const context = {
      sessionId: 'session-tier',
      modelConfig: config({ serviceTier: UNATTENDED_SERVICE_TIER, apiKey: 'k' }),
    } as Parameters<typeof normalizeSubagentModelContext>[0];
    const normalized = normalizeSubagentModelContext(context, 'explore');
    expect(normalized.modelConfig.serviceTier).toBe(UNATTENDED_SERVICE_TIER);
    expect(normalized.modelConfig.provider).toBe('openai');
  });
});
