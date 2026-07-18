import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildProviderReportedSavedTokensSmokeContract,
  validateProviderReportedSavedTokensDecision,
  validateProviderReportedSavedTokensLiveGate,
  validateProviderReportedSavedTokensLiveResponse,
} from '../../../scripts/acceptance/provider-reported-saved-tokens-smoke';

describe('provider-reported saved-token smoke helpers', () => {
  it('uses the checked-in local runner instead of npx for repeatable npm smoke runs', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = packageJson.scripts['acceptance:provider-saved-tokens'];

    expect(script).toBe('jiti scripts/acceptance/provider-reported-saved-tokens-smoke.ts');
    expect(script).not.toContain('npx');
  });

  it('exposes the provider-reported saved-token contract and live evidence boundary', () => {
    expect(buildProviderReportedSavedTokensSmokeContract()).toEqual({
      mode: 'provider-reported-saved-token-contract',
      accepts: {
        tokenSavingsStatus: 'provider-reported',
        providerReportSource: 'provider-reported',
        measurementSavingsSource: 'provider-reported',
        measurementProviderReportedSavings: true,
      },
      rejects: [
        'provider usage alone as saved-token evidence',
        'tool-spec local estimate basis mixed into provider-reported savings',
        'provider-reported status without providerReport.savedTokens',
      ],
      manualLiveGate: {
        requiredFlag: '--manual-provider',
        requiredEnv: 'CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1',
        stillRequires: [
          'real provider response with usage.providerReportedSavedTokens or equivalent provider/tool saved-token field',
          'programmatic tool calling enabled in a live request',
          'live evidence that provider-reported saved tokens survive modelDecision event normalization',
        ],
      },
    });
  });

  it('passes the checked-in provider-reported fixture', () => {
    const decision = JSON.parse(readFileSync(
      new URL('../../fixtures/provider-reported-saved-tokens-decision.json', import.meta.url),
      'utf8',
    )) as unknown;

    expect(validateProviderReportedSavedTokensDecision({ decision, fixture: 'fixture.json' })).toMatchObject({
      ok: true,
      status: 'passed',
      mode: 'model-decision-fixture',
      savedTokens: 42,
      providerUsage: {
        inputTokens: 500,
        outputTokens: 50,
        totalTokens: 550,
      },
      failedChecks: [],
    });
  });

  it('rejects provider usage without a provider-reported saved-token field', () => {
    const result = validateProviderReportedSavedTokensDecision({
      decision: {
        toolStrategy: {
          tokenSavings: {
            status: 'estimated',
            savedTokens: 42,
            measurement: {
              savingsSource: 'tool-spec-local-estimate',
              usageSource: 'model-response-usage',
              providerReportedSavings: false,
            },
            providerUsage: {
              source: 'model-response-usage',
              inputTokens: 500,
              outputTokens: 50,
              totalTokens: 550,
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.failedChecks).toEqual(expect.arrayContaining([
      'statusIsProviderReported',
      'providerReportPresent',
      'measurementMarksProviderReported',
    ]));
    expect(result.failedChecks).not.toContain('providerUsagePresent');
  });

  it('rejects provider-reported savings that still carry local-estimate basis', () => {
    const result = validateProviderReportedSavedTokensDecision({
      decision: {
        toolStrategy: {
          tokenSavings: {
            status: 'provider-reported',
            savedTokens: 42,
            measurement: {
              savingsSource: 'provider-reported',
              usageSource: 'model-response-usage',
              providerReportedSavings: true,
            },
            basis: {
              source: 'tool-spec-local-estimate',
              toolCount: 2,
              fields: ['name', 'description', 'inputSchema'],
            },
            providerReport: {
              source: 'provider-reported',
              savedTokens: 42,
            },
            providerUsage: {
              source: 'model-response-usage',
              inputTokens: 500,
              outputTokens: 50,
              totalTokens: 550,
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.failedChecks).toEqual(['localEstimateBasisAbsent']);
  });

  it('passes a manual live response artifact only when provider-reported saved tokens are present', () => {
    const result = validateProviderReportedSavedTokensLiveResponse({
      liveResponse: 'live.json',
      response: {
        usage: {
          inputTokens: 500,
          outputTokens: 50,
          providerReportedSavedTokens: 42,
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'passed',
      mode: 'provider-live-response-artifact',
      liveResponse: 'live.json',
      savedTokens: 42,
      providerUsage: {
        inputTokens: 500,
        outputTokens: 50,
        totalTokens: 550,
      },
      failedChecks: [],
    });
  });

  it('blocks live response artifacts that only include provider usage', () => {
    const result = validateProviderReportedSavedTokensLiveResponse({
      liveResponse: 'usage-only.json',
      response: {
        usage: {
          input_tokens: 500,
          output_tokens: 50,
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.providerUsage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      totalTokens: 550,
    });
    expect(result.failedChecks).toEqual([
      'providerReportedSavedTokensPresent',
      'providerReportedSavedTokensFinite',
    ]);
  });

  it('requires an explicit manual gate for provider live response evidence', () => {
    expect(() => validateProviderReportedSavedTokensLiveGate({
      manualProvider: false,
      env: { CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE: '1' },
    })).toThrow(/--manual-provider/);

    expect(() => validateProviderReportedSavedTokensLiveGate({
      manualProvider: true,
      env: { CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE: undefined },
    })).toThrow(/CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1/);

    expect(() => validateProviderReportedSavedTokensLiveGate({
      manualProvider: true,
      env: { CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE: '1' },
    })).not.toThrow();
  });
});
