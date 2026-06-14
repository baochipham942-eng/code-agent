import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildModelStrategySurfaceVisibilityResult } from '../../../scripts/acceptance/model-strategy-surface-visibility';

describe('model strategy surface visibility acceptance', () => {
  it('uses the cached tsx runner for repeatable surface visibility smoke runs', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['acceptance:model-strategy-surface']).toBe(
      'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-surface-visibility.ts',
    );
  });

  it('proves billing, provider identity, provider badges, and model strategy tooltip are visible', () => {
    const result = buildModelStrategySurfaceVisibilityResult();

    expect(result).toMatchObject({
      ok: true,
      status: 'passed',
      failedChecks: [],
      checks: {
        routeTraceShowsPaygSavings: true,
        routeTraceShowsPlanNoSavings: true,
        routeTraceShowsUnknownConservative: true,
        routeTraceShowsProviderIdentity: true,
        modelSwitcherShowsBillingBadge: true,
        modelSwitcherShowsHealthBadge: true,
        modelSwitcherShowsSourceAndTransport: true,
        modelSwitcherTooltipShowsTaskStrategyContext: true,
      },
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('RouteTraceChip renders payg'),
      expect.stringContaining('ModelSwitcher provider badges expose billing'),
    ]));
  });
});
