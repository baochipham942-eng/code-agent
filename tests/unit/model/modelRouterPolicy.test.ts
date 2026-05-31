import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_FALLBACK_CHAIN } from '../../../src/shared/constants';
import type { ModelMessage } from '../../../src/main/model/types';
import {
  classifyProviderFallbackReason,
  extractMessageText,
  formatFallbackReason,
  getFallbackChainForRequest,
  hasArtifactFileWriteRequiredMarker,
  isArtifactLikeRequest,
  shouldAllowArtifactFallbackAfterSelectedRetry,
  shouldKeepArtifactRequestOnSelectedProvider,
  shouldRetryArtifactNonStreaming,
  shouldRetrySelectedArtifactProvider,
} from '../../../src/main/model/modelRouterPolicy';

const artifactMessages: ModelMessage[] = [
  { role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' },
];

describe('modelRouterPolicy', () => {
  describe('classifyProviderFallbackReason', () => {
    it('classifies provider errors into stable fallback categories', () => {
      expect(classifyProviderFallbackReason('request timeout after 90000ms')).toBe('timeout');
      expect(classifyProviderFallbackReason('Xiaomi API error: 429 too many requests')).toBe('rate_limit');
      expect(classifyProviderFallbackReason('Xiaomi API error: 402 - insufficient balance')).toBe('quota');
      expect(classifyProviderFallbackReason('401 unauthorized')).toBe('auth');
      expect(classifyProviderFallbackReason('502 bad gateway')).toBe('provider_unavailable');
      expect(classifyProviderFallbackReason('Network request failed: socket hang up')).toBe('network');
      expect(classifyProviderFallbackReason('empty artifact response from xiaomi')).toBe('artifact_response');
      expect(classifyProviderFallbackReason('model_not_allowed: model is not available')).toBe('model');
    });

    it('formats fallback reasons without leaking multiline provider payloads', () => {
      expect(formatFallbackReason('first line\nsecond line')).toBe('first line');
      expect(formatFallbackReason('')).toBe('unknown');
      expect(formatFallbackReason('x'.repeat(300))).toHaveLength(240);
    });
  });

  describe('artifact request policy', () => {
    it('detects artifact-like requests and write-required markers', () => {
      expect(isArtifactLikeRequest(artifactMessages)).toBe(true);

      const markerMessages: ModelMessage[] = [
        { role: 'user', content: '继续' },
        {
          role: 'system',
          content: '<artifact-file-write-required>\n目标产物文件是 /tmp/out/game.html。\n</artifact-file-write-required>',
        },
      ];
      expect(hasArtifactFileWriteRequiredMarker(markerMessages)).toBe(true);
    });

    it('extracts text from multimodal messages for pure policy checks', () => {
      expect(extractMessageText({
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'part two' },
        ],
      })).toBe('part one\npart two');
    });

    it('does not non-streaming retry blocked artifact repair tool turns', () => {
      const blockedMessages: ModelMessage[] = [
        ...artifactMessages,
        {
          role: 'tool',
          content: '<artifact-repair-tool-blocked>\nRead is limited during repair.\n</artifact-repair-tool-blocked>',
          toolCallId: 'call-1',
          toolError: true,
        },
      ];

      expect(shouldRetryArtifactNonStreaming(
        blockedMessages,
        new Error('stream inactivity timeout'),
        vi.fn(),
      )).toBe(false);
    });

    it('keeps transient artifact errors on the selected provider but releases hard failures', () => {
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'network')).toBe(true);
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'provider_unavailable')).toBe(true);
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'quota')).toBe(false);
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'auth')).toBe(false);
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'model')).toBe(false);
      expect(shouldKeepArtifactRequestOnSelectedProvider(artifactMessages, 'artifact_response')).toBe(false);
      expect(shouldKeepArtifactRequestOnSelectedProvider([{ role: 'user', content: 'hello' }], 'network')).toBe(false);
    });

    it('only allows timeout fallback after selected-provider retry in active artifact repair', () => {
      expect(shouldRetrySelectedArtifactProvider('provider_unavailable')).toBe(true);
      expect(shouldRetrySelectedArtifactProvider('network')).toBe(true);
      expect(shouldRetrySelectedArtifactProvider('rate_limit')).toBe(true);
      expect(shouldRetrySelectedArtifactProvider('timeout')).toBe(false);
      expect(shouldRetrySelectedArtifactProvider('timeout', { artifactRepairActive: true })).toBe(true);

      expect(shouldAllowArtifactFallbackAfterSelectedRetry('timeout')).toBe(false);
      expect(shouldAllowArtifactFallbackAfterSelectedRetry('timeout', { artifactRepairActive: true })).toBe(true);
    });
  });

  describe('fallback chain policy', () => {
    it('keeps the configured fallback order for normal requests', () => {
      expect(getFallbackChainForRequest([{ role: 'user', content: 'hello' }], 'xiaomi'))
        .toEqual(PROVIDER_FALLBACK_CHAIN.xiaomi);
    });

    it('reprioritizes artifact requests toward artifact-capable fallback providers', () => {
      expect(getFallbackChainForRequest(artifactMessages, 'xiaomi').map((target) => target.provider))
        .toEqual(['zhipu', 'deepseek', 'openai', 'moonshot']);
    });
  });
});
