import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
import { resolveOnboardingDefaultEngine } from '../../../src/renderer/stores/sessionCreate';

function settingsWithDefault(
  defaultEngine: AppSettings['onboarding'] extends infer T
    ? T extends { defaultEngine?: infer K }
      ? K
      : never
    : never,
): AppSettings {
  return {
    onboarding: { defaultEngine },
    models: {
      default: 'gpt-5.6-sol',
      providers: {},
      agentEngines: {
        codex_cli: { defaultModel: 'gpt-5.6-sol' },
      },
      routing: {
        code: { provider: 'openai', model: 'gpt-5.6-sol' },
        vision: { provider: 'openai', model: 'gpt-5.6-sol' },
        fast: { provider: 'openai', model: 'gpt-5.6-sol' },
        gui: { provider: 'openai', model: 'gpt-5.6-sol' },
      },
    },
  } as AppSettings;
}

describe('resolveOnboardingDefaultEngine', () => {
  it('applies an external onboarding default only inside a workspace', () => {
    expect(resolveOnboardingDefaultEngine(
      settingsWithDefault('codex_cli'),
      '/tmp/workspace',
    )).toEqual({
      kind: 'codex_cli',
      model: 'gpt-5.6-sol',
      cwd: '/tmp/workspace',
    });
  });

  it('keeps quick conversations and native defaults on Neo', () => {
    expect(resolveOnboardingDefaultEngine(
      settingsWithDefault('codex_cli'),
      null,
    )).toBeNull();
    expect(resolveOnboardingDefaultEngine(
      settingsWithDefault('native'),
      '/tmp/workspace',
    )).toBeNull();
  });
});
