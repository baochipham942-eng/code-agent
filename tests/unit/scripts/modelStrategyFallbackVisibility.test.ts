import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildModelStrategyFallbackVisibilityResult } from '../../../scripts/acceptance/model-strategy-fallback-visibility';

describe('model strategy fallback visibility acceptance', () => {
  it('uses the checked-in local runner for repeatable fallback visibility smoke runs', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['acceptance:model-strategy-fallback']).toBe(
      'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-fallback-visibility.ts',
    );
  });

  it('proves fallback strategy, identity, trace, tool policy, and toast wording are visible', () => {
    const result = buildModelStrategyFallbackVisibilityResult();

    expect(result).toMatchObject({
      ok: true,
      status: 'passed',
      failedChecks: [],
      checks: {
        bannerShowsCapabilityStrategy: true,
        bannerShowsFromToProviderIdentity: true,
        bannerShowsTraceGroups: true,
        bannerShowsToolPolicyDisabled: true,
        bannerShowsExhaustedProviderFallback: true,
        bannerCollapsedShowsFromTo: true,
        providerToastUsesStrategyMode: true,
        providerToastShowsMainTaskRecovery: true,
      },
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('FallbackBanner renders strategy label'),
      expect.stringContaining('ProviderStatusNotice uses the same strategy labels'),
    ]));
  });
});
