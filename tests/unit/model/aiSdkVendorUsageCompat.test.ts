import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract/model';

const capabilityOverride = vi.hoisted(() => ({ noStreamOptions: false }));

vi.mock('../../../src/host/model/modelCapabilityMatrix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/model/modelCapabilityMatrix')>();
  return {
    ...actual,
    resolveModelCapabilities(provider: string, model: string) {
      const resolved = actual.resolveModelCapabilities(provider, model);
      if (!capabilityOverride.noStreamOptions) return resolved;
      return {
        ...resolved,
        requestCompat: {
          ...resolved.requestCompat,
          noStreamOptions: true,
        },
      };
    },
  };
});

import { buildVendorCompatSettings } from '../../../src/host/model/adapters/aiSdkVendorCompat';

const config = (provider: string, model: string, over: Partial<ModelConfig> = {}): ModelConfig =>
  ({ provider, model, apiKey: 'test-key', ...over }) as ModelConfig;

afterEach(() => {
  capabilityOverride.noStreamOptions = false;
});

describe('buildVendorCompatSettings — provider usage compatibility', () => {
  it('defaults custom openai-compatible providers to include provider usage', () => {
    expect(buildVendorCompatSettings(config('custom-tokenrhythm', 'chat-model')).includeUsage).toBe(true);
  });

  it('enables usage for DeepSeek without replacing its reasoning_effort transform', () => {
    const settings = buildVendorCompatSettings(config('deepseek', 'deepseek-reasoner', {
      reasoningEffort: 'high',
    }));

    expect(settings.includeUsage).toBe(true);
    expect(settings.transformRequestBody?.({ messages: [] })).toMatchObject({
      reasoning_effort: 'high',
    });
  });

  it('honours the capability-matrix opt-out for endpoints that reject stream_options', () => {
    capabilityOverride.noStreamOptions = true;

    expect(buildVendorCompatSettings(config('custom-no-stream-options', 'chat-model')).includeUsage)
      .toBeUndefined();
  });

  it('keeps existing vendor usage flags and request transforms', () => {
    const zhipu = buildVendorCompatSettings(config('zhipu', 'glm-5'));
    const moonshot = buildVendorCompatSettings(config('moonshot', 'kimi-k2.5'));
    const qwenSearchOn = buildVendorCompatSettings(config('qwen', 'qwen-flash'));
    const qwenSearchOff = buildVendorCompatSettings(config('qwen', 'qwen-flash'), { searchEnabled: false });
    const xiaomi = buildVendorCompatSettings(config('xiaomi', 'mimo-v2.5-pro'));

    expect(zhipu.includeUsage).toBe(true);
    expect(moonshot.includeUsage).toBe(true);
    expect(qwenSearchOn.includeUsage).toBe(true);
    expect(qwenSearchOff.includeUsage).toBe(true);
    expect(xiaomi.includeUsage).toBe(true);
    expect(moonshot.transformRequestBody?.({ messages: [] })).toMatchObject({
      temperature: 1,
      top_p: 0.95,
    });
    expect(xiaomi.transformRequestBody?.({ messages: [] })).toMatchObject({
      thinking: { type: 'disabled' },
    });
  });
});
