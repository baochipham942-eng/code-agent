import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeSubscriptionSmokeContract,
  buildClaudeSubscriptionSmokeArgs,
  parseClaudeSubscriptionSmokeLine,
  parseClaudeSubscriptionSmokeOutput,
  replayClaudeSubscriptionSmokeFixture,
  validateClaudeSubscriptionSmokeGate,
} from '../../../scripts/acceptance/claude-subscription-cli-smoke';

describe('claude subscription CLI smoke helpers', () => {
  it('uses the checked-in local runner instead of npx for repeatable npm smoke runs', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = packageJson.scripts['acceptance:claude-subscription-cli'];

    expect(script).toBe('jiti scripts/acceptance/claude-subscription-cli-smoke.ts');
    expect(script).not.toContain('npx');
  });

  it('uses the same guarded stream-json print-mode contract as the Claude adapter', () => {
    const args = buildClaudeSubscriptionSmokeArgs({ model: 'sonnet' });

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--input-format') + 1]).toBe('text');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('exposes the dry-run contract as structured strategy evidence', () => {
    expect(buildClaudeSubscriptionSmokeContract({ model: 'sonnet' })).toEqual({
      requestMode: 'claude-print',
      transport: 'stdin-text',
      model: 'sonnet',
      stream: {
        outputFormat: 'stream-json',
        includePartialMessages: true,
        expectedEvents: [
          'system:init',
          'stream_event:content_block_delta',
          'assistant:snapshot',
          'result',
        ],
      },
      permissions: {
        permissionMode: 'plan',
        settingSources: 'local',
        slashCommands: 'disabled',
        sessionPersistence: false,
      },
      tools: {
        policy: 'read-only',
        tools: ['Read', 'Glob', 'Grep', 'LS'],
        allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
        strictMcpConfig: true,
        mcpBridge: 'offline-replay-plus-manual-live-gate',
      },
      transcript: {
        mode: 'clean-result-text',
        parseErrorsVisible: true,
        terminalNoiseFiltered: true,
        expectedMarkerRequired: true,
      },
      offlineCoverage: [
        'command-shape',
        'cli-version-probe',
        'stream-json-parser',
        'long-response-partial-fixture-replay',
        'tool-use-fixture-replay',
        'mcp-tool-use-tool-result-fixture-replay',
        'terminal-noise-filtering',
        'expected-marker',
        'auth-quota-runtime-failure-classification',
      ],
      manualLiveGate: {
        requiredFlag: '--manual-claude',
        requiredEnv: 'CODE_AGENT_CLAUDE_CLI_SMOKE=1',
        stillRequires: [
          'logged-in subscription account',
          'quota-available request',
          'live long-response subscription request',
          'live MCP bridge tool execution',
        ],
      },
    });
  });

  it('parses stream-json result output and requires the expected marker', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ALMA_' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
        session_id: 'claude-session',
      }),
    ].join('\n');

    expect(parseClaudeSubscriptionSmokeOutput({
      stdout,
      stderr: '',
      exitCode: 0,
      expectedText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      occurredAt: 123,
    })).toMatchObject({
      ok: true,
      status: 'passed',
      finalText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      externalSessionId: 'claude-session',
      eventCounts: {
        init: 1,
        streamDelta: 1,
        result: 1,
      },
    });
  });

  it('parses stream-json tool_use events from streamed content blocks', () => {
    expect(parseClaudeSubscriptionSmokeLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: 'docs/research/alma-model-strategy.md' },
        },
      },
      session_id: 'claude-session',
    }))).toMatchObject({
      type: 'stream_event',
      toolName: 'Read',
      sessionId: 'claude-session',
    });
  });

  it('classifies Claude auth failures as blocked evidence instead of pass', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'authentication_failed',
      session_id: 'claude-session',
    });

    expect(parseClaudeSubscriptionSmokeOutput({
      stdout,
      stderr: '',
      exitCode: 1,
      expectedText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      occurredAt: 456,
    })).toMatchObject({
      ok: false,
      status: 'blocked',
      externalSessionId: 'claude-session',
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        retryable: false,
        occurredAt: 456,
        statusCode: 401,
        exitCode: 1,
        reliability: { authState: 'needs_login' },
      },
    });
  });

  it('requires both the manual flag and env guard before a real Claude request', () => {
    expect(() => validateClaudeSubscriptionSmokeGate({
      manualClaude: false,
      env: { CODE_AGENT_CLAUDE_CLI_SMOKE: '1' },
    })).toThrow(/manual-only/);

    expect(() => validateClaudeSubscriptionSmokeGate({
      manualClaude: true,
      env: {},
    })).toThrow(/CODE_AGENT_CLAUDE_CLI_SMOKE=1/);

    expect(() => validateClaudeSubscriptionSmokeGate({
      manualClaude: true,
      env: { CODE_AGENT_CLAUDE_CLI_SMOKE: '1' },
    })).not.toThrow();
  });

  it('keeps parse errors visible without crashing the smoke parser', () => {
    expect(parseClaudeSubscriptionSmokeLine('not-json')).toEqual({
      error: 'parse_error: not-json',
    });
    expect(parseClaudeSubscriptionSmokeOutput({
      stdout: 'not-json\n',
      stderr: '',
      exitCode: 0,
      expectedText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      occurredAt: 789,
    })).toMatchObject({
      ok: false,
      status: 'failed',
      eventCounts: { parseError: 1 },
    });
  });

  it('replays long-response stream-json fixtures without duplicating snapshots or transcript noise', () => {
    const finalText = 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK long response reconstructed from partial chunks.';
    const stdout = [
      'Claude Code terminal footer should stay out of transcript',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ALMA_MODEL_' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'STRATEGY_CLAUDE_' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SMOKE_OK long response reconstructed from partial chunks.' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
        },
        session_id: 'claude-session',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-session' }),
      'tokens used: 9999',
    ].join('\n');

    expect(replayClaudeSubscriptionSmokeFixture({
      stdout,
      expectedText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      source: 'fixture.ndjson',
      occurredAt: 123,
    })).toMatchObject({
      ok: true,
      status: 'passed',
      finalText,
      externalSessionId: 'claude-session',
      eventCounts: {
        init: 1,
        streamDelta: 3,
        assistantSnapshot: 1,
        result: 1,
        parseError: 2,
      },
      replay: {
        mode: 'stream-json-fixture',
        source: 'fixture.ndjson',
        observed: {
          streamDelta: 3,
          assistantSnapshot: 1,
          toolUse: 0,
          result: 1,
          parseError: 2,
        },
        requirements: {
          requireToolUse: false,
        },
        checks: {
          expectedMarkerFound: true,
          partialDeltasReassembled: true,
          assistantSnapshotNotDuplicated: true,
          terminalNoiseFiltered: true,
          requiredToolUseObserved: true,
          resultEventObserved: true,
        },
        failedChecks: [],
      },
    });
  });

  it('can require MCP tool-use and tool-result events for bridge fixture replay', () => {
    const finalText = 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK MCP bridge tool event observed.';
    const stdout = [
      'tool result: {"file":"should stay out of transcript"}',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp__workspace__read_file',
            input: { path: 'docs/research/alma-model-strategy.md' },
          },
        },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'fixture content' }],
        },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ALMA_MODEL_STRATEGY_' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CLAUDE_SMOKE_OK MCP bridge tool event observed.' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
        },
        session_id: 'claude-session',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-session' }),
    ].join('\n');

    expect(replayClaudeSubscriptionSmokeFixture({
      stdout,
      expectedText: 'ALMA_MODEL_STRATEGY_CLAUDE_SMOKE_OK',
      requireToolUse: true,
      expectMcpBridge: true,
      source: 'mcp-fixture.ndjson',
      occurredAt: 123,
    })).toMatchObject({
      ok: true,
      status: 'passed',
      finalText,
      eventCounts: {
        init: 1,
        streamDelta: 2,
        assistantSnapshot: 1,
        toolUse: 1,
        mcpToolUse: 1,
        toolResult: 1,
        result: 1,
        parseError: 1,
      },
      replay: {
        source: 'mcp-fixture.ndjson',
        observed: {
          streamDelta: 2,
          assistantSnapshot: 1,
          toolUse: 1,
          mcpToolUse: 1,
          toolResult: 1,
          result: 1,
          parseError: 1,
        },
        requirements: {
          requireToolUse: true,
          requireMcpBridge: true,
        },
        checks: {
          expectedMarkerFound: true,
          partialDeltasReassembled: true,
          assistantSnapshotNotDuplicated: true,
          terminalNoiseFiltered: true,
          requiredToolUseObserved: true,
          requiredMcpToolUseObserved: true,
          requiredToolResultObserved: true,
          resultEventObserved: true,
        },
        failedChecks: [],
      },
    });
  });
});
