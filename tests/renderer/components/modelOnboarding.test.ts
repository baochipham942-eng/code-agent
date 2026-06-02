import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_OFFICIAL_PROVIDERS,
  ONBOARDING_RELAY_CARD,
  buildOnboardingModelSelection,
  getOnboardingProviderCards,
  selectOnboardingDefaultModel,
} from '../../../src/renderer/components/onboarding/modelOnboarding';

describe('model onboarding helpers', () => {
  it('shows official direct providers and excludes advanced provider types', () => {
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('deepseek');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('moonshot');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('openai');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).toContain('longcat');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('openrouter');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('local');
    expect(ONBOARDING_OFFICIAL_PROVIDERS).not.toContain('custom');
  });

  it('keeps the recommended providers first for new users', () => {
    const recommended = getOnboardingProviderCards()
      .filter((card) => card.recommended)
      .map((card) => card.id);

    expect(recommended).toEqual(['deepseek', 'moonshot', 'zhipu', 'qwen']);
  });

  it('prefers a discovered registry default when available', () => {
    expect(selectOnboardingDefaultModel('openai', [
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
      },
    ])).toBe('gpt-5.5');
  });

  it('offers a relay card that requires a user-supplied base URL', () => {
    // 官方卡片列表仍不含 custom（中转卡片单独走 ONBOARDING_RELAY_CARD），避免和官方直连混在一起
    expect(getOnboardingProviderCards().map((card) => card.id)).not.toContain('custom');
    expect(ONBOARDING_RELAY_CARD).toMatchObject({
      id: 'custom',
      requiresBaseUrl: true,
    });
  });

  it('builds relay selection from discovered models with the user base URL', () => {
    const selection = buildOnboardingModelSelection({
      provider: 'custom',
      apiKey: 'sk-relay-test',
      baseUrl: 'https://windhub.cc/v1',
      discoveredModels: [
        { id: 'deepseek-v3-2-251201', label: 'DeepSeek V3.2' },
        { id: 'doubao-seed-1-8-251228', label: '豆包 Seed 1.8' },
      ],
    });

    // 默认模型取第一个发现的模型，不能落到中转站不存在的 custom-model 占位
    expect(selection.modelConfig).toMatchObject({
      provider: 'custom',
      model: 'deepseek-v3-2-251201',
      baseUrl: 'https://windhub.cc/v1',
    });
    expect(selection.providerSettings.models?.['deepseek-v3-2-251201']?.enabled).toBe(true);
    expect(selection.providerSettings.models?.['doubao-seed-1-8-251228']?.enabled).toBe(true);
  });

  it('falls back to built-in provider defaults when discovery returns nothing', () => {
    const selection = buildOnboardingModelSelection({
      provider: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      discoveredModels: [],
    });

    expect(selection.modelConfig).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(selection.providerSettings.models?.['deepseek-v4-flash']?.enabled).toBe(true);
  });
});
