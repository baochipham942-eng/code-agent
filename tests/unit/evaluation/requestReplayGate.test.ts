import { describe, expect, it } from 'vitest';
import {
  assertReconstructedRequestMatches,
  RequestReplayMismatchError,
} from '../../../src/host/evaluation/requestReplayGate';

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
});
