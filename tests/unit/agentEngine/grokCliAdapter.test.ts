import { describe, expect, it } from 'vitest';
import {
  buildGrokArgs,
  buildGrokEnv,
  parseGrokJsonLine,
} from '../../../src/host/services/agentEngine/grokCliAdapter';

describe('GrokCliAdapter protocol', () => {
  it('builds a bounded read-only single-turn invocation', () => {
    expect(buildGrokArgs('read_only', 'grok-4.5', 'nonce')).toEqual([
      '--no-auto-update',
      '-p',
      'nonce',
      '--output-format',
      'streaming-json',
      '--permission-mode',
      'plan',
      '--tools',
      '',
      '--disable-web-search',
      '--no-subagents',
      '--no-memory',
      '--max-turns',
      '1',
      '--model',
      'grok-4.5',
    ]);
  });

  it('normalizes streamed text, end identity, and errors', () => {
    expect(parseGrokJsonLine('{"type":"text","data":"NEO"}')).toEqual({
      textDelta: 'NEO',
      textDeltaSource: 'stream',
    });
    expect(parseGrokJsonLine('{"type":"end","stopReason":"EndTurn","sessionId":"session-1"}'))
      .toEqual({
        status: 'EndTurn',
        externalSessionId: 'session-1',
      });
    expect(parseGrokJsonLine('{"type":"error","message":"login required"}'))
      .toEqual({ error: 'login required', statusCode: undefined });
  });

  it('does not forward unrelated API credentials', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-forward';
    try {
      const env = buildGrokEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.HOME).toBeTruthy();
      expect(env.PATH).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});
