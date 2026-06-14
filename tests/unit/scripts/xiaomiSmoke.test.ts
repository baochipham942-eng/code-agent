import { describe, expect, it } from 'vitest';
import { buildXiaomiProviderResponseArtifact } from '../../../scripts/acceptance/xiaomi-provider-response-artifact';
import { validateProviderReportedSavedTokensLiveResponse } from '../../../scripts/acceptance/provider-reported-saved-tokens-smoke';

describe('xiaomi provider smoke artifact helpers', () => {
  it('builds a bounded tool-calling provider response artifact', () => {
    const artifact = buildXiaomiProviderResponseArtifact({
      model: 'mimo-v2.5-pro',
      capturedAt: '2026-06-14T00:00:00.000Z',
      response: {
        usage: {
          inputTokens: 120,
          outputTokens: 30,
        },
        toolCalls: [
          {
            id: 'tool-1',
            name: 'get_weather',
            arguments: { city: 'Shanghai' },
            result: { success: true, data: { temp: 26 } },
            liveOutput: { output: 'debug output', type: 'stdout', timestamp: Date.now() },
          },
        ],
      },
    });

    expect(artifact).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      scenario: 'tool-calling',
      capturedAt: '2026-06-14T00:00:00.000Z',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
      },
      toolCalls: [
        {
          name: 'get_weather',
          arguments: { city: 'Shanghai' },
        },
      ],
    });
    expect(JSON.stringify(artifact)).not.toContain('debug output');
  });

  it('emits live-response artifacts compatible with the saved-token gate', () => {
    const artifact = buildXiaomiProviderResponseArtifact({
      model: 'mimo-v2.5-pro',
      capturedAt: '2026-06-14T00:00:00.000Z',
      response: {
        usage: {
          inputTokens: 500,
          outputTokens: 50,
          providerReportedSavedTokens: 42,
        },
        toolCalls: [
          { id: 'tool-1', name: 'get_weather', arguments: { city: 'Shanghai' } },
        ],
      },
    });

    expect(validateProviderReportedSavedTokensLiveResponse({
      liveResponse: 'xiaomi-provider-response.json',
      response: artifact,
    })).toMatchObject({
      ok: true,
      status: 'passed',
      savedTokens: 42,
      providerUsage: {
        inputTokens: 500,
        outputTokens: 50,
        totalTokens: 550,
      },
      failedChecks: [],
    });
  });
});
