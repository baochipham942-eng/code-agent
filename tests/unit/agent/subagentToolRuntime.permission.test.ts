import { beforeEach, describe, expect, it, vi } from 'vitest';

const toolExecutorState = vi.hoisted(() => ({
  config: undefined as undefined | {
    requestPermission: (request: {
      sessionId?: string;
      forceConfirm?: boolean;
      type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
      tool: string;
      details: Record<string, unknown>;
    }) => Promise<boolean>;
    telemetryCollector?: unknown;
    permissionModeOverride?: PermissionMode;
  },
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {
    constructor(config: typeof toolExecutorState.config) {
      toolExecutorState.config = config;
    }
  },
}));

import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { PermissionMode } from '../../../src/host/permissions/modes';

describe('createSubagentToolRuntime permission forwarding', () => {
  beforeEach(() => {
    toolExecutorState.config = undefined;
  });

  function captureRequestPermission(input: {
    effectiveMode: PermissionMode;
    permissionResult?: boolean;
  }) {
    const permissionRequest = vi.fn(async () => input.permissionResult ?? false);
    createSubagentToolRuntime({
      context: {
        sessionId: 'session-1',
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId: 'session-1',
      effectiveMode: input.effectiveMode,
      identity: { agentId: 'agent-1', runId: 'run-1', parentToolUseId: 'parent-tool-1' },
      allowedToolNames: new Set(['Write', 'Bash']),
      checkToolExecution: vi.fn(() => true),
    });
    expect(toolExecutorState.config).toBeDefined();
    return {
      requestPermission: toolExecutorState.config!.requestPermission,
      permissionRequest,
    };
  }

  it.each([
    { effectiveMode: 'acceptEdits' as const, type: 'file_write' as const, tool: 'Write' },
    { effectiveMode: 'bypassPermissions' as const, type: 'command' as const, tool: 'Bash' },
  ])('forwards forceConfirm requests through $effectiveMode instead of auto-approving', async ({
    effectiveMode,
    type,
    tool,
  }) => {
    const { requestPermission, permissionRequest } = captureRequestPermission({
      effectiveMode,
      permissionResult: false,
    });

    const approved = await requestPermission({
      type,
      tool,
      details: {},
      forceConfirm: true,
    });

    expect(approved).toBe(false);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      forceConfirm: true,
      parentToolUseId: 'parent-tool-1',
      runId: 'run-1',
      tool,
      type,
    }));
  });

  it('keeps acceptEdits auto-approving write requests when forceConfirm is absent', async () => {
    const { requestPermission, permissionRequest } = captureRequestPermission({
      effectiveMode: 'acceptEdits',
      permissionResult: false,
    });

    const approved = await requestPermission({
      type: 'file_write',
      tool: 'Write',
      details: {},
    });

    expect(approved).toBe(true);
    expect(permissionRequest).not.toHaveBeenCalled();
  });

  it('async_agent 后台路径切到 unattended 档，并保留 forceConfirm 人工闸', async () => {
    const permissionRequest = vi.fn(async () => false);
    createSubagentToolRuntime({
      context: {
        sessionId: 'session-background',
        cwd: '/tmp/workbench',
        executionTopology: 'async_agent',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId: 'session-background',
      effectiveMode: 'default',
      identity: { agentId: 'agent-background', runId: 'run-background' },
      allowedToolNames: new Set(['Bash']),
      checkToolExecution: vi.fn(() => true),
    });

    expect(toolExecutorState.config?.permissionModeOverride).toBe('unattended');
    await expect(toolExecutorState.config!.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: {},
    })).resolves.toBe(true);
    await expect(toolExecutorState.config!.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: {},
      forceConfirm: true,
    })).resolves.toBe(false);
    expect(permissionRequest).toHaveBeenCalledOnce();
  });

  it('passes the case-local telemetry owner into nested subagent tool execution', () => {
    const telemetryCollector = { marker: 'case-local' };
    createSubagentToolRuntime({
      context: {
        sessionId: 'session-1',
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
        telemetryCollector,
      } as any,
      sessionId: 'session-1',
      effectiveMode: 'default',
      identity: { agentId: 'agent-1', runId: 'run-1' },
      allowedToolNames: new Set(['Task']),
      checkToolExecution: vi.fn(() => true),
    });

    expect(toolExecutorState.config?.telemetryCollector).toBe(telemetryCollector);
  });
});
