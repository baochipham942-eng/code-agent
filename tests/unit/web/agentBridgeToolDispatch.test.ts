import { describe, expect, it, vi } from 'vitest';
import { createRunContext } from '../../../src/host/runtime/runContext';
import type { ToolContext } from '../../../src/host/tools/types';
import {
  createBridgeToolDispatch,
  type PendingLocalToolCall,
} from '../../../src/web/routes/agentBridgeToolDispatch';

function toolContext(workspace: string, runId: string, sessionId: string): ToolContext {
  return {
    runId,
    sessionId,
    workspace,
    workingDirectory: workspace,
    requestPermission: vi.fn().mockResolvedValue(true),
  };
}

describe('createBridgeToolDispatch', () => {
  it('carries the immutable run context and maps file paths for the local Bridge', async () => {
    const runContext = createRunContext({
      runId: 'run-bridge-context',
      sessionId: 'session-bridge-context',
      workspace: '/tmp/bridge-context',
    });
    const pending = new Map<string, PendingLocalToolCall>();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const dispatch = createBridgeToolDispatch({
      runContext,
      pendingLocalToolCalls: pending,
      emitSSE: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      logger: { warn: vi.fn() } as never,
    });

    const resultPromise = dispatch(
      'Write',
      { file_path: 'output.txt', content: 'run-owned' },
      toolContext(runContext.workspace, runContext.runId, runContext.sessionId),
      { runId: runContext.runId, sessionId: runContext.sessionId },
    );

    expect(pending.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'tool_call_local',
      data: {
        tool: 'file_write',
        originalTool: 'Write',
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        workspace: runContext.workspace,
        cwd: runContext.cwd,
        params: {
          file_path: 'output.txt',
          path: 'output.txt',
          cwd: runContext.cwd,
        },
      },
    });

    pending.values().next().value?.resolve({ success: true, output: 'written' });
    await expect(resultPromise).resolves.toMatchObject({ success: true, output: 'written' });
    expect(pending.size).toBe(0);
  });

  it('finishes only the target pending wait and emits a Bridge cancel on abort', async () => {
    const runContext = createRunContext({
      runId: 'run-bridge-cancel',
      sessionId: 'session-bridge-cancel',
      workspace: '/tmp/bridge-cancel',
    });
    const pending = new Map<string, PendingLocalToolCall>();
    const emitSSE = vi.fn();
    const dispatch = createBridgeToolDispatch({
      runContext,
      pendingLocalToolCalls: pending,
      emitSSE,
      logger: { warn: vi.fn() } as never,
    });
    const abortController = new AbortController();

    const resultPromise = dispatch(
      'Bash',
      { command: 'sleep 30', working_directory: '/tmp/bridge-cancel' },
      toolContext(runContext.workspace, runContext.runId, runContext.sessionId),
      {
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        abortSignal: abortController.signal,
      },
    );
    const toolCallId = pending.keys().next().value as string;
    abortController.abort();

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: "Local tool 'Bash' cancelled",
    });
    expect(pending.size).toBe(0);
    expect(emitSSE).toHaveBeenCalledWith('tool_cancel_local', {
      toolCallId,
      runId: runContext.runId,
      sessionId: runContext.sessionId,
    });
  });

  it('falls back inside the same ToolExecutor when the renderer reports Bridge unavailable', async () => {
    const runContext = createRunContext({
      runId: 'run-bridge-fallback',
      sessionId: 'session-bridge-fallback',
      workspace: '/tmp/bridge-fallback',
    });
    const pending = new Map<string, PendingLocalToolCall>();
    const warn = vi.fn();
    const dispatch = createBridgeToolDispatch({
      runContext,
      pendingLocalToolCalls: pending,
      emitSSE: vi.fn(),
      logger: { warn } as never,
    });

    const resultPromise = dispatch(
      'Read',
      { file_path: 'input.txt' },
      toolContext(runContext.workspace, runContext.runId, runContext.sessionId),
      { runId: runContext.runId, sessionId: runContext.sessionId },
    );
    pending.values().next().value?.resolve({
      success: false,
      error: 'Local Bridge is not connected. Please start it.',
    });

    await expect(resultPromise).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
