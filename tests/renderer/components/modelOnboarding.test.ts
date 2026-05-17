import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_OFFICIAL_PROVIDERS,
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
