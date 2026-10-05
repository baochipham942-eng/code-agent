import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEffortControls } from '../../../src/host/agent/runtime/contextAssembly/effortControls';
import {
  explicitlyDeclaredEffortLevels,
  PROVIDER_REGISTRY,
} from '../../../src/host/model/providerRegistry';
import type { ModelConfig, ModelInfo, ModelReasoningEffort } from '../../../src/shared/contract/model';

const FIXTURE_PROVIDER = 'test-fixture-effort-provider';
const FIXTURE_MODEL = 'test-fixture-effort-model';
const FIXTURE_MODEL_B = 'test-fixture-effort-model-b';

function modelCount(): number {
  return Object.values(PROVIDER_REGISTRY).reduce((count, provider) => count + provider.models.length, 0);
}

const providersBefore = Object.keys(PROVIDER_REGISTRY).length;
const modelsBefore = modelCount();

function fixtureModel(id: string, levels: ModelReasoningEffort[]): ModelInfo {
  return {
    id,
    name: id,
    capabilities: ['general'],
    maxTokens: 1024,
    supportsTool: true,
    supportsVision: false,
    supportsStreaming: true,
    thinking: { kind: 'effort', levels },
  };
}

function config(modelId: string, extra: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: FIXTURE_PROVIDER,
    model: modelId,
    ...extra,
  };
}

describe('applyEffortControls catalogue pass-through', () => {
  beforeEach(() => {
    PROVIDER_REGISTRY[FIXTURE_PROVIDER] = {
      id: FIXTURE_PROVIDER,
      name: 'Test fixture',
      requiresApiKey: false,
      models: [
        fixtureModel(FIXTURE_MODEL, ['low', 'medium', 'high', 'xhigh', 'max']),
        fixtureModel(FIXTURE_MODEL_B, ['low', 'medium', 'high']),
      ],
    };
  });

  afterEach(() => {
    delete PROVIDER_REGISTRY[FIXTURE_PROVIDER];
    expect(Object.keys(PROVIDER_REGISTRY)).toHaveLength(providersBefore);
    expect(modelCount()).toBe(modelsBefore);
    expect(PROVIDER_REGISTRY[FIXTURE_PROVIDER]).toBeUndefined();
  });

  afterAll(() => {
    delete PROVIDER_REGISTRY[FIXTURE_PROVIDER];
    expect(Object.keys(PROVIDER_REGISTRY)).toHaveLength(providersBefore);
    expect(modelCount()).toBe(modelsBefore);
  });

  it('(a) passes xhigh and max through when the catalogue declares them', () => {
    expect(applyEffortControls(config(FIXTURE_MODEL), 'xhigh', { thinkingEnabled: true })).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      reasoningEffort: 'xhigh',
      thinkingBudget: 32768,
    });
    expect(applyEffortControls(config(FIXTURE_MODEL), 'max', { thinkingEnabled: true })).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      reasoningEffort: 'max',
      thinkingBudget: 65536,
    });
  });

  it('(b) still clamps ultra_code to high', () => {
    expect(applyEffortControls(config(FIXTURE_MODEL), 'ultra_code', { thinkingEnabled: true })).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      reasoningEffort: 'high',
      thinkingBudget: 49152,
    });
  });

  it('(c) clamps a level the catalogue entry does not declare', () => {
    expect(applyEffortControls(config(FIXTURE_MODEL_B), 'xhigh', { thinkingEnabled: true })).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL_B,
      reasoningEffort: 'high',
      thinkingBudget: 32768,
    });
    expect(applyEffortControls(config(FIXTURE_MODEL_B), 'max', { thinkingEnabled: true })).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL_B,
      reasoningEffort: 'high',
      thinkingBudget: 65536,
    });
  });

  it('(d) clamps a model whose effort levels come only from the fallback matrix', () => {
    expect(explicitlyDeclaredEffortLevels('openai', 'gpt-5.4')).toBeUndefined();
    expect(explicitlyDeclaredEffortLevels('openai', 'gpt-5.5')).toEqual(['low', 'medium', 'high']);
    expect(PROVIDER_REGISTRY.openai.models.find((model) => model.id === 'gpt-5.4')?.thinking).toEqual({
      kind: 'effort',
      levels: ['low', 'medium', 'high'],
    });

    const undeclared: ModelConfig = { provider: 'openai', model: 'gpt-5.4' };
    expect(applyEffortControls(undeclared, 'low', { thinkingEnabled: true }).reasoningEffort).toBe('low');
    expect(applyEffortControls(undeclared, 'medium', { thinkingEnabled: true }).reasoningEffort).toBe('medium');
    expect(applyEffortControls(undeclared, 'high', { thinkingEnabled: true }).reasoningEffort).toBe('high');
    expect(applyEffortControls(undeclared, 'xhigh', { thinkingEnabled: true }).reasoningEffort).toBe('high');
    expect(applyEffortControls(undeclared, 'max', { thinkingEnabled: true }).reasoningEffort).toBe('high');
    expect(applyEffortControls(undeclared, 'ultra_code', { thinkingEnabled: true }).reasoningEffort).toBe('high');
  });

  it('(e) clears reasoningEffort and thinkingBudget when thinking is off', () => {
    expect(applyEffortControls(
      config(FIXTURE_MODEL, { reasoningEffort: 'low', thinkingBudget: 1 }),
      'xhigh',
      { thinkingEnabled: false },
    )).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      reasoningEffort: undefined,
      thinkingBudget: undefined,
    });
  });

  it('(f) keeps a preset reasoningEffort ahead of the derived level', () => {
    expect(applyEffortControls(
      config(FIXTURE_MODEL, { reasoningEffort: 'low' }),
      'xhigh',
      { thinkingEnabled: true },
    )).toEqual({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      reasoningEffort: 'low',
      thinkingBudget: 32768,
    });
  });
});
