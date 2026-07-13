import { describe, expect, it } from 'vitest';
import { PROVIDER_REGISTRY } from '../../../src/host/model/providerRegistry';
import { resolveModelThinkingCapability } from '../../../src/host/model/providerRuntimeCapabilities';
import type { ModelEntrySettings } from '../../../src/shared/contract/settings';
import { getModelThinkingCapabilityCatalog } from '../../../src/host/ipc/provider.ipc';

function model(provider: string, modelId: string) {
  const result = PROVIDER_REGISTRY[provider]?.models.find((entry) => entry.id === modelId);
  expect(result, `${provider}/${modelId} must exist in the registry`).toBeDefined();
  return result!;
}

describe('per-model thinking capabilities', () => {
  it('distinguishes Claude budget, OpenAI effort, GLM toggle, and LongCat toggle controls', () => {
    expect(model('claude', 'claude-opus-4-7').thinking).toEqual({
      kind: 'budget',
      minBudgetTokens: 1024,
      defaultBudgetTokens: 16384,
    });
    expect(model('openai', 'gpt-5.5').thinking).toEqual({
      kind: 'effort',
      levels: ['low', 'medium', 'high'],
    });
    expect(model('zhipu', 'glm-5').thinking).toEqual({ kind: 'toggle', defaultEnabled: true });
    expect(model('longcat', 'LongCat-2.0-Preview').thinking).toEqual({ kind: 'toggle', defaultEnabled: true });
  });

  it('keeps known non-thinking and unknown models explicit', () => {
    expect(model('openai', 'gpt-4o').thinking).toEqual({ kind: 'none' });
    expect(resolveModelThinkingCapability('custom')).toEqual({ kind: 'unknown' });

    for (const provider of Object.values(PROVIDER_REGISTRY)) {
      for (const entry of provider.models) {
        expect(entry.thinking).toBeDefined();
        expect(entry.thinking?.kind).toMatch(
          /^(budget|effort|toggle|none|unknown)$/,
        );
      }
    }
  });

  it('falls back from missing model metadata to the provider reasoning-effort matrix', () => {
    expect(resolveModelThinkingCapability('openai')).toEqual({
      kind: 'effort',
      levels: ['low', 'medium', 'high'],
    });
    expect(model('openai', 'gpt-5.4').thinking).toEqual({
      kind: 'effort',
      levels: ['low', 'medium', 'high'],
    });
  });

  it('accepts a persisted per-model preference for each configurable control shape', () => {
    const settings: Record<string, ModelEntrySettings> = {
      claude: { thinking: { enabled: true, budgetTokens: 8192 } },
      openai: { thinking: { enabled: true, effort: 'high' } },
      glm: { thinking: { enabled: false } },
    };

    expect(settings).toEqual({
      claude: { thinking: { enabled: true, budgetTokens: 8192 } },
      openai: { thinking: { enabled: true, effort: 'high' } },
      glm: { thinking: { enabled: false } },
    });
  });

  it('exposes resolved model metadata and provider fallback to the settings UI', () => {
    const claude = getModelThinkingCapabilityCatalog('claude');
    expect(claude.models['claude-opus-4-7']).toEqual({
      kind: 'budget',
      minBudgetTokens: 1024,
      defaultBudgetTokens: 16384,
    });

    const custom = getModelThinkingCapabilityCatalog('custom-team-provider');
    expect(custom.models).toEqual({});
    expect(custom.fallback).toEqual({ kind: 'unknown' });
  });
});
