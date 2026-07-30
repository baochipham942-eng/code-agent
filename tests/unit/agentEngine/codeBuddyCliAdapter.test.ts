import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodeBuddyArgs,
  buildCodeBuddyEnv,
} from '../../../src/host/services/agentEngine/codeBuddyCliAdapter';
import { parseClaudeProtocolJsonLine } from '../../../src/host/services/agentEngine/claudeCodeAdapter';

describe('CodeBuddy CLI adapter contract', () => {
  const originalConfigDir = process.env.CODEBUDDY_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
    else process.env.CODEBUDDY_CONFIG_DIR = originalConfigDir;
  });

  it('uses the proved print-mode argv transport and disables every built-in tool', () => {
    const args = buildCodeBuddyArgs('read_only', 'client_default', 'reply with nonce');

    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'text',
      '--permission-mode',
      'plan',
      '--tools',
      '',
      '--strict-mcp-config',
      '--max-turns',
      '1',
      '--include-partial-messages',
      'reply with nonce',
    ]);
    expect(args).not.toContain('--model');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('passes a probed model but never treats client_default as a real model id', () => {
    const args = buildCodeBuddyArgs('read_only', 'glm-5.2', 'hello');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
      .toEqual(['--model', 'glm-5.2']);
  });

  it('points the CLI at official WorkBuddy state and strips ambient secrets', () => {
    process.env.CODEBUDDY_CONFIG_DIR = '/official/workbuddy-state';
    process.env.OPENAI_API_KEY = 'must-not-leak';
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';

    const env = buildCodeBuddyEnv();

    expect(env.CODEBUDDY_CONFIG_DIR).toBe('/official/workbuddy-state');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('must-not-leak');
  });

  it('normalizes CodeBuddy stream-json deltas, results, and session identity', () => {
    expect(parseClaudeProtocolJsonLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'WB' },
      },
      session_id: 'workbuddy-session',
    }), 'WorkBuddy')).toMatchObject({
      textDelta: 'WB',
      textDeltaSource: 'stream',
      externalSessionId: 'workbuddy-session',
    });

    expect(parseClaudeProtocolJsonLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
    }), 'WorkBuddy')).toMatchObject({
      finalText: 'done',
      status: 'WorkBuddy result: success',
    });
  });
});
