/**
 * Regression test for the 2026-06-11 mimo dogfood bug: xiaomi/moonshot vendor
 * `transformRequestBody` was defined but never applied (createOpenAICompatible
 * ignores the non-standard field and makeAiSdkFetch didn't consume it), so
 * mimo's thinking:{type:'disabled'} was never sent → thinking defaulted ON →
 * runaway reasoning (313s, 0 content, finish=length) on contract-sized prompts.
 *
 * This locks the vendor-quirk CONTENT. The wiring (fetch applies the transform)
 * is covered end-to-end by the live acceptance run.
 */

import { describe, it, expect } from 'vitest';
import { buildVendorCompatSettings } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { ModelConfig } from '../../../src/shared/contract/model';

const xiaomi = (over: Partial<ModelConfig> = {}): ModelConfig =>
  ({ provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'k', ...over }) as ModelConfig;

describe('buildVendorCompatSettings — xiaomi/mimo thinking control', () => {
  it('disables thinking by default (no reasoningEffort / no thinkingBudget)', () => {
    const settings = buildVendorCompatSettings(xiaomi());
    expect(settings.transformRequestBody).toBeTypeOf('function');
    const body = settings.transformRequestBody!({ model: 'mimo-v2.5-pro', messages: [] });
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('enables thinking when reasoningEffort is high', () => {
    const settings = buildVendorCompatSettings(xiaomi({ reasoningEffort: 'high' } as Partial<ModelConfig>));
    const body = settings.transformRequestBody!({ messages: [] });
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('enables thinking when thinkingBudget > 0', () => {
    const settings = buildVendorCompatSettings(xiaomi({ thinkingBudget: 2048 } as Partial<ModelConfig>));
    const body = settings.transformRequestBody!({ messages: [] });
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('renames max_tokens → max_completion_tokens (mimo API quirk) without clobbering an existing one', () => {
    const settings = buildVendorCompatSettings(xiaomi());
    const renamed = settings.transformRequestBody!({ messages: [], max_tokens: 8000 });
    expect(renamed.max_completion_tokens).toBe(8000);
    expect(renamed.max_tokens).toBeUndefined();

    const kept = settings.transformRequestBody!({ messages: [], max_tokens: 8000, max_completion_tokens: 4000 });
    expect(kept.max_completion_tokens).toBe(4000); // existing wins, not overwritten
  });

  it('applies mimo official sampling defaults but lets caller values win', () => {
    const settings = buildVendorCompatSettings(xiaomi());
    const dflt = settings.transformRequestBody!({ messages: [] });
    expect(dflt.temperature).toBe(1.0);
    expect(dflt.top_p).toBe(0.95);

    const caller = settings.transformRequestBody!({ messages: [], temperature: 0.3, top_p: 0.5 });
    expect(caller.temperature).toBe(0.3);
    expect(caller.top_p).toBe(0.5);
  });

  it('moonshot also exposes a sampling transform; plain openai-compatible providers do not', () => {
    expect(buildVendorCompatSettings({ provider: 'moonshot', model: 'kimi-k2.5' } as ModelConfig).transformRequestBody).toBeTypeOf('function');
    expect(buildVendorCompatSettings({ provider: 'longcat', model: 'x' } as ModelConfig).transformRequestBody).toBeUndefined();
  });

  it('注入 enable_search 的开关来自能力矩阵，不是 provider 名硬编码', () => {
    // 矩阵把百炼搜索声明在 qwen 的 default 档（不分模型），所以任意 qwen 模型都注入。
    for (const model of ['qwen-flash', 'qwen3-coder-plus']) {
      const settings = buildVendorCompatSettings({ provider: 'qwen', model } as ModelConfig);
      expect(settings.transformRequestBody?.({ messages: [] })).toMatchObject({ enable_search: true });
    }
    // 负例：矩阵未声明 search 的 openai-compatible provider 不能被顺带打开。
    expect(buildVendorCompatSettings({ provider: 'longcat', model: 'LongCat-2.0' } as ModelConfig).transformRequestBody)
      .toBeUndefined();
  });
});
