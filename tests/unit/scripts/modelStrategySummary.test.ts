import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildModelStrategyAcceptanceSummary } from '../../../scripts/acceptance/model-strategy-summary';

describe('model strategy acceptance summary', () => {
  it('uses the local Vite acceptance runner because the summary renders TSX components', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = packageJson.scripts['acceptance:model-strategy-summary'];

    expect(script).toBe('node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-summary.ts');
  });

  it('summarizes offline evidence while keeping external live gates pending', () => {
    const packageScripts = {
      'acceptance:claude-subscription-cli': 'jiti scripts/acceptance/claude-subscription-cli-smoke.ts',
      'acceptance:codex-cli-engine': 'jiti scripts/acceptance/codex-cli-engine-smoke.ts',
      'acceptance:provider-saved-tokens': 'jiti scripts/acceptance/provider-reported-saved-tokens-smoke.ts',
      'acceptance:model-strategy-fallback': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-fallback-visibility.ts',
      'acceptance:model-strategy-surface': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-surface-visibility.ts',
      'acceptance:model-strategy-summary': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-summary.ts',
      'test:e2e:model-strategy': 'playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/model-strategy-recommendation.spec.ts',
    };

    const summary = buildModelStrategyAcceptanceSummary({
      packageScripts,
      env: {},
    });

    expect(summary).toMatchObject({
      ok: true,
      status: 'offline-passed-live-gates-pending',
    });
    expect(summary.checks.filter((check) => check.status === 'failed')).toEqual([]);
    expect(summary.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude-subscription-offline-contract',
        status: 'passed',
      }),
      expect.objectContaining({
        id: 'provider-saved-token-contract',
        status: 'passed',
      }),
      expect.objectContaining({
        id: 'xiaomi-provider-artifact-contract',
        status: 'passed',
      }),
      expect.objectContaining({
        id: 'route-trace-complexity-boundary',
        status: 'passed',
        area: 'decision-explainability',
      }),
      expect.objectContaining({
        id: 'route-trace-provider-health-boundary',
        status: 'passed',
        area: 'decision-explainability',
      }),
      expect.objectContaining({
        id: 'fallback-visibility-contract',
        status: 'passed',
        area: 'decision-explainability',
      }),
      expect.objectContaining({
        id: 'surface-billing-identity-contract',
        status: 'passed',
        area: 'decision-explainability',
      }),
      expect.objectContaining({
        id: 'task-recommendation-capability-contract',
        status: 'passed',
        area: 'task-recommendation',
        evidence: expect.arrayContaining([
          'provider health recommendations filter candidates by this-turn required capabilities',
          'simple tasks prefer healthy fast candidates when provider health forces a switch',
          'provider-health dismiss keys are scoped by task type',
          'capability and external-attachment recommendation keys are scoped by task input',
          'recommendation apply/dismiss feedback emits privacy-bounded task signals',
        ]),
      }),
      expect.objectContaining({
        id: 'codex-cli-live-smoke',
        status: 'needs-live-evidence',
      }),
      expect.objectContaining({
        id: 'xiaomi-live-tool-calling',
        status: 'needs-live-evidence',
      }),
      expect.objectContaining({
        id: 'provider-saved-token-live-boundary',
        status: 'needs-live-evidence',
        blockers: expect.arrayContaining([
          'XIAOMI_API_KEY is not visible in process env or ~/.code-agent/.env',
        ]),
      }),
      expect.objectContaining({
        id: 'model-strategy-e2e-in-app-browser',
        status: 'needs-live-evidence',
      }),
    ]));
    expect(summary.liveGates.map((gate) => gate.id)).toEqual([
      'codex-cli-live-smoke',
      'xiaomi-live-tool-calling',
      'provider-saved-token-live-boundary',
      'model-strategy-e2e-in-app-browser',
    ]);
  });

  it('accepts Codex CLI, Xiaomi live tool calling, and in-app Browser evidence without reopening those gates', () => {
    const packageScripts = {
      'acceptance:claude-subscription-cli': 'jiti scripts/acceptance/claude-subscription-cli-smoke.ts',
      'acceptance:codex-cli-engine': 'jiti scripts/acceptance/codex-cli-engine-smoke.ts',
      'acceptance:provider-saved-tokens': 'jiti scripts/acceptance/provider-reported-saved-tokens-smoke.ts',
      'acceptance:model-strategy-fallback': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-fallback-visibility.ts',
      'acceptance:model-strategy-surface': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-surface-visibility.ts',
      'acceptance:model-strategy-summary': 'node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/model-strategy-summary.ts',
      'test:e2e:model-strategy': 'playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/model-strategy-recommendation.spec.ts',
    };

    const summary = buildModelStrategyAcceptanceSummary({
      packageScripts,
      env: {},
      localEnvPresence: { XIAOMI_API_KEY: '<present>' },
      codexCliSmokeResult: {
        ok: true,
        status: 'passed',
        version: 'codex-cli 0.139.0',
        finalText: 'CODEX_MODEL_STRATEGY_OK',
        eventCounts: { turnCompleted: 1 },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      xiaomiLiveResponse: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        usage: { inputTokens: 823, outputTokens: 78 },
        toolCalls: [{ id: 'tool-1', name: 'get_weather', arguments: { city: '上海' } }],
      },
      inAppBrowserModelStrategyOk: true,
    });

    expect(summary).toMatchObject({
      ok: true,
      status: 'passed',
    });
    expect(summary.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'codex-cli-live-smoke',
        status: 'passed',
        evidence: expect.arrayContaining([
          'version=codex-cli 0.139.0',
        ]),
      }),
      expect.objectContaining({
        id: 'xiaomi-live-tool-calling',
        status: 'passed',
        evidence: expect.arrayContaining([
          'toolCalls=1',
          'usage=823/78',
        ]),
      }),
      expect.objectContaining({
        id: 'model-strategy-e2e-in-app-browser',
        status: 'passed',
      }),
      expect.objectContaining({
        id: 'provider-saved-token-live-boundary',
        status: 'passed',
        evidence: expect.arrayContaining([
          'provider usage is present but provider-reported saved-token field is absent',
          'usage-only response remains classified as not provider-reported savings',
        ]),
        failedChecks: expect.arrayContaining([
          'providerReportedSavedTokensPresent',
          'providerReportedSavedTokensFinite',
        ]),
      }),
      expect.objectContaining({
        id: 'fallback-visibility-contract',
        status: 'passed',
        evidence: expect.arrayContaining([
          expect.stringContaining('FallbackBanner renders strategy label'),
        ]),
      }),
      expect.objectContaining({
        id: 'surface-billing-identity-contract',
        status: 'passed',
        evidence: expect.arrayContaining([
          expect.stringContaining('RouteTraceChip renders payg'),
        ]),
      }),
      expect.objectContaining({
        id: 'task-recommendation-capability-contract',
        status: 'passed',
        evidence: expect.arrayContaining([
          'image tasks do not switch to healthy candidates without vision capability',
          'simple tasks prefer healthy fast candidates when provider health forces a switch',
          'provider-health dismiss keys are scoped by task type',
          'capability and external-attachment recommendation keys are scoped by task input',
          'recommendation apply/dismiss feedback emits privacy-bounded task signals',
        ]),
      }),
    ]));
    expect(summary.liveGates).toEqual([]);
  });

  it('fails when required package script wiring drifts', () => {
    const summary = buildModelStrategyAcceptanceSummary({
      packageScripts: {
        'acceptance:claude-subscription-cli': 'npx tsx scripts/acceptance/claude-subscription-cli-smoke.ts',
      },
      env: {},
    });

    expect(summary.ok).toBe(false);
    expect(summary.status).toBe('failed');
    expect(summary.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'script:acceptance:claude-subscription-cli',
        status: 'failed',
        failedChecks: expect.arrayContaining([
          expect.stringContaining('jiti scripts/acceptance/claude-subscription-cli-smoke.ts'),
        ]),
      }),
      expect.objectContaining({
        id: 'script:acceptance:codex-cli-engine',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'script:acceptance:provider-saved-tokens',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'script:acceptance:model-strategy-fallback',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'script:acceptance:model-strategy-surface',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'script:acceptance:model-strategy-summary',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'script:test:e2e:model-strategy',
        status: 'failed',
      }),
    ]));
  });
});
