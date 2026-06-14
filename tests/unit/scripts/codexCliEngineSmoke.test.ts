import { describe, expect, it } from 'vitest';
import {
  buildCodexCliEngineSmokeArgs,
  buildCodexCliEngineSmokeContract,
  parseCodexCliEngineSmokeLine,
  parseCodexCliEngineSmokeOutput,
} from '../../../scripts/acceptance/codex-cli-engine-smoke';

describe('codex CLI engine smoke', () => {
  it('builds a read-only codex exec command with clean last-message capture', () => {
    const args = buildCodexCliEngineSmokeArgs({
      cwd: '/repo',
      model: 'gpt-5',
      outputLastMessagePath: '/tmp/codex-last.md',
    });

    expect(args).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-5',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--output-last-message',
      '/tmp/codex-last.md',
    ]);
  });

  it('documents the live gate without requiring Claude subscription auth', () => {
    const contract = buildCodexCliEngineSmokeContract({ model: null });

    expect(contract).toMatchObject({
      requestMode: 'codex-exec',
      transport: 'prompt-argument',
      permissions: {
        sandbox: 'read-only',
        outputLastMessage: true,
      },
      manualLiveGate: {
        requiredFlag: '--manual-codex',
        requiredEnv: 'CODE_AGENT_CODEX_CLI_SMOKE=1',
      },
    });
    expect(contract.offlineCoverage).toContain('auth-quota-runtime-failure-classification');
  });

  it('parses real codex exec JSONL events and ignores terminal noise', async () => {
    const stdout = [
      'WARNING: proceeding, even though aliases could not be created',
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'CODEX_MODEL_STRATEGY_OK' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      }),
    ].join('\n');

    const result = await parseCodexCliEngineSmokeOutput({
      stdout,
      stderr: '',
      exitCode: 0,
      expectedText: 'CODEX_MODEL_STRATEGY_OK',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'passed',
      finalText: 'CODEX_MODEL_STRATEGY_OK',
      threadId: 'thread-1',
      eventCounts: {
        threadStarted: 1,
        turnStarted: 1,
        agentMessage: 1,
        turnCompleted: 1,
        usage: 1,
        parseError: 1,
      },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
    });
  });

  it('blocks auth or quota failures instead of reporting a false pass', async () => {
    const result = await parseCodexCliEngineSmokeOutput({
      stdout: '',
      stderr: 'API Error: 429 quota exhausted',
      exitCode: 1,
      expectedText: 'CODEX_MODEL_STRATEGY_OK',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.failure?.reason).toBe('quota_exhausted');
  });

  it('exposes item.completed error events without treating successful runs as parse failures', () => {
    const event = parseCodexCliEngineSmokeLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'error', message: 'deprecated config' },
    }));

    expect(event).toMatchObject({
      type: 'item.completed',
      itemType: 'error',
    });
  });
});
