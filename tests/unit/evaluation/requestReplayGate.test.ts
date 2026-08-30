import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  assertReconstructedRequestMatches,
  RequestReplayMismatchError,
  verifyRequestReplayBatch,
} from '@internal-evaluation/host/evaluation/requestReplayGate';
import type { RequestReplayGateCase } from '@internal-evaluation/host/evaluation/requestReplayGate';

describe('assertReconstructedRequestMatches', () => {
  it('accepts byte-identical canonical messages and tools', () => {
    const message = { role: 'user', content: 'same' };
    expect(() => assertReconstructedRequestMatches([message], '[]', {
      messages: [message],
      canonicalMessages: [JSON.stringify(message)],
      tools: [],
      canonicalTools: '[]',
    })).not.toThrow();
  });

  it('prints the message index, first byte offset, and both excerpts', () => {
    const message = { role: 'user', content: 'actual' };
    expect(() => assertReconstructedRequestMatches([message], '[]', {
      messages: [{ role: 'user', content: 'replay' }],
      canonicalMessages: [JSON.stringify({ role: 'user', content: 'replay' })],
      tools: [],
      canonicalTools: '[]',
    })).toThrowError(RequestReplayMismatchError);
    try {
      assertReconstructedRequestMatches([message], '[]', {
        messages: [{ role: 'user', content: 'replay' }],
        canonicalMessages: [JSON.stringify({ role: 'user', content: 'replay' })],
        tools: [],
        canonicalTools: '[]',
      });
    } catch (error) {
      expect(String(error)).toMatch(/message\[0\].*byte \d+/s);
      expect(String(error)).toContain('实发');
      expect(String(error)).toContain('重建');
    }
  });

  it('rejects a one-byte tool table mutation', () => {
    expect(() => assertReconstructedRequestMatches([], '[{"name":"Read"}]', {
      messages: [],
      canonicalMessages: [],
      tools: [{ name: 'Raad' }],
      canonicalTools: '[{"name":"Raad"}]',
    })).toThrow(/tools.*第一处差异/s);
  });

  it('skips degraded rounds, reports the blind spot count, and verifies healthy rounds', () => {
    const emptyTools = '[]';
    const toolSchemaHash = createHash('sha256').update(emptyTools).digest('hex');
    const getToolSchema = vi.fn(() => emptyTools);
    const healthy = {
      manifest: {
        requestId: 'healthy',
        messageRefs: [],
        toolSchemaHash,
        toolNames: [],
        requested: { provider: 'p', model: 'm', temperature: null, maxTokens: null, reasoningEffort: null, thinkingBudget: null },
        actualProvider: 'p',
        actualModel: 'm',
        appVersion: 'v',
        adapterDefaults: { engine: 'legacy' as const, temperature: null, maxTokens: null },
        compactionReplacements: [],
        degraded: false,
      },
      ledgerMessages: [],
      readers: {
        getSystemPrompt: () => null,
        getContent: () => null,
        getToolSchema,
      },
      actualMessages: [],
      actualTools: [],
    } satisfies RequestReplayGateCase;
    const report = vi.fn();
    const degraded = { ...healthy, manifest: { ...healthy.manifest, requestId: 'degraded', degraded: true } };

    expect(verifyRequestReplayBatch([healthy, degraded], report))
      .toEqual({ verified: 1, skippedDegraded: 1 });
    expect(report).toHaveBeenCalledWith('request replay gate: 跳过 1 轮 degraded');
    expect(getToolSchema).toHaveBeenCalledTimes(1);
  });
});
