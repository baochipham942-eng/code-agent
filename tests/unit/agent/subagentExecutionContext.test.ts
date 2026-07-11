import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/host/protocol/tools';
import { createProtocolSubagentExecutionContext } from '../../../src/host/agent/subagentExecutionContext';
import type { RunTraceContext } from '../../../src/host/telemetry/runTraceContext';

function makeProtocolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run-a',
    sessionId: 'session-a',
    workspace: '/workspace/a',
    workingDir: '/workspace/a/cwd',
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(),
    modelConfig: { provider: 'mock', model: 'model-a' },
    resolver: { getDefinition: vi.fn() },
    currentToolCallId: 'call-a',
    ...overrides,
  } as unknown as ToolContext;
}

describe('protocol-native SubagentExecutionContext', () => {
  it('preserves explicit run/session/workspace/cwd for concurrent runs', () => {
    const allow = vi.fn(async () => ({ allow: true as const }));
    const first = createProtocolSubagentExecutionContext(makeProtocolContext(), allow);
    const second = createProtocolSubagentExecutionContext(makeProtocolContext({
      runId: 'run-b',
      sessionId: 'session-b',
      workspace: '/workspace/b',
      workingDir: '/workspace/b/cwd',
      currentToolCallId: 'call-b',
    }), allow);

    expect(first).toMatchObject({
      runId: 'run-a',
      sessionId: 'session-a',
      workspace: '/workspace/a',
      cwd: '/workspace/a/cwd',
      currentToolCallId: 'call-a',
    });
    expect(second).toMatchObject({
      runId: 'run-b',
      sessionId: 'session-b',
      workspace: '/workspace/b',
      cwd: '/workspace/b/cwd',
      currentToolCallId: 'call-b',
    });
    expect(first).not.toBe(second);
    expect(first.abortSignal).not.toBe(second.abortSignal);
  });

  it('returns the real permission callback decision and request hint', async () => {
    const canUseTool = vi.fn(async () => ({ allow: false as const, reason: 'user denied' }));
    const context = createProtocolSubagentExecutionContext(makeProtocolContext(), canUseTool);

    await expect(context.permission.request({
      sessionId: 'session-a',
      type: 'network',
      tool: 'web_fetch',
      details: { url: 'https://example.com' },
      reason: 'fetch evidence',
    })).resolves.toBe(false);
    expect(canUseTool).toHaveBeenCalledWith(
      'web_fetch',
      { url: 'https://example.com' },
      'fetch evidence',
      expect.objectContaining({ sessionId: 'session-a', type: 'network' }),
    );
  });

  it('preserves the injected trace parent without consulting global state', () => {
    const traceContext = {
      traceId: 'trace-a',
      spanId: 'span-parent',
    } as unknown as RunTraceContext;
    const context = createProtocolSubagentExecutionContext(
      makeProtocolContext({ traceContext }),
      vi.fn(async () => ({ allow: true as const })),
    );

    expect(context.traceContext).toBe(traceContext);
  });
});
