// ============================================================================
// Prompt provider 变体（roadmap 2.4）— Claude 系 vs GPT/国产系
// ============================================================================
// 不同模型失败模式不同：Claude 易话多/git 误操作，GPT/国产系易过早停。
// 变体为主提示词追加家族段落（additive，不改 base，控 eval 回退面）。
// ============================================================================

import { afterEach, describe, it, expect } from 'vitest';
import {
  resolveProviderFamily,
  applyProviderVariant,
  PROVIDER_VARIANT_MARKER,
} from '../../../src/main/prompts/providerVariants';

afterEach(() => {
  delete process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT;
});

describe('resolveProviderFamily', () => {
  it('maps anthropic/claude to the claude family', () => {
    expect(resolveProviderFamily('anthropic')).toBe('claude');
    expect(resolveProviderFamily('claude')).toBe('claude');
    expect(resolveProviderFamily('custom-relay', 'claude-sonnet-4-6')).toBe('claude');
  });

  it('maps gpt and domestic providers to the autonomous family', () => {
    for (const p of [
      'openai',
      'azure-openai',
      'moonshot',
      'deepseek',
      'zhipu',
      'xiaomi',
      'qwen',
      'alibaba',
      'minimax',
      'baidu',
      'volcengine',
      'longcat',
      'groq',
    ]) {
      expect(resolveProviderFamily(p), p).toBe('autonomous');
    }
    expect(resolveProviderFamily(undefined, 'gpt-5.4')).toBe('autonomous');
    expect(resolveProviderFamily(undefined, 'glm-5')).toBe('autonomous');
    expect(resolveProviderFamily(undefined, 'doubao-seed-1.6')).toBe('autonomous');
    expect(resolveProviderFamily(undefined, 'ernie-x1')).toBe('autonomous');
  });

  it('handles owner-prefixed model ids and relay providers (openrouter/custom-*)', () => {
    expect(resolveProviderFamily('openrouter', 'openai/gpt-5.2')).toBe('autonomous');
    expect(resolveProviderFamily('openrouter', 'anthropic/claude-opus-4-8')).toBe('claude');
    expect(resolveProviderFamily('custom-commonstack-claude', undefined)).toBe('claude');
    expect(resolveProviderFamily('custom-xiaomi-ultraspeed', 'mimo-v2.5-pro-ultraspeed')).toBe('autonomous');
  });

  it('returns default for unknown providers without model hints', () => {
    expect(resolveProviderFamily('mystery-provider')).toBe('default');
    expect(resolveProviderFamily(undefined, undefined)).toBe('default');
  });
});

describe('applyProviderVariant', () => {
  const base = 'BASE SYSTEM PROMPT';

  it('appends git-safety discipline for the claude family', () => {
    const out = applyProviderVariant(base, 'anthropic', 'claude-sonnet-4-6');
    expect(out).toContain(base);
    expect(out).toContain(PROVIDER_VARIANT_MARKER);
    expect(out).toMatch(/NEVER update the git config/i);
    expect(out).toMatch(/NEW commits rather than amending/i);
  });

  it('appends autonomy/persistence discipline for the autonomous family', () => {
    const out = applyProviderVariant(base, 'deepseek', 'deepseek-v4-flash');
    expect(out).toContain(PROVIDER_VARIANT_MARKER);
    expect(out).toMatch(/Persist until the task is fully handled/i);
    expect(out).not.toMatch(/NEVER update the git config/i);
  });

  it('returns the base prompt unchanged for unknown families', () => {
    expect(applyProviderVariant(base, 'mystery', undefined)).toBe(base);
  });

  it('can disable provider variants for same-model eval A/B runs', () => {
    process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT = '1';

    expect(applyProviderVariant(base, 'anthropic', 'claude-sonnet-4-6')).toBe(base);
    expect(applyProviderVariant(base, 'deepseek', 'deepseek-v4-flash')).toBe(base);
  });

  it('does not get disabled by heading-like text in the base prompt (opaque sentinel)', () => {
    const trap = 'x\n## Provider-family discipline\ny';
    const out = applyProviderVariant(trap, 'deepseek', 'deepseek-v4-flash');
    expect(out).toMatch(/Persist until the task is fully handled/i);
  });

  it('is idempotent — never double-appends the variant section', () => {
    const once = applyProviderVariant(base, 'deepseek', 'deepseek-v4-flash');
    const twice = applyProviderVariant(once, 'deepseek', 'deepseek-v4-flash');
    expect(twice).toBe(once);
  });
});
