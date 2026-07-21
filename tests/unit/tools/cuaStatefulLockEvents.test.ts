import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../../src/shared/contract';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../../src/host/mcp/cuaStateAdapter';
import { gateCuaToolCall } from '../../../src/host/mcp/cuaSessionLock';
import { CuaStatefulComputerUseHandler } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SurfaceExecutionRuntime } from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

class LockAwareCuaDriver implements CuaDriverPort {
  mutationCount = 0;
  private observation = 0;

  async call(
    toolName: string,
    _args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    const scope = context.surfaceSessionId || context.sessionId;
    const blocked = await gateCuaToolCall(toolName, scope);
    if (blocked) return { success: false, error: blocked };
    if (toolName === 'list_windows') {
      return {
        success: true,
        structured: {
          windows: [{
            pid: 42,
            window_id: 7,
            app_name: 'Notes',
            title: 'Lock lifecycle fixture',
            is_on_screen: true,
            on_current_space: true,
          }],
        },
      };
    }
    if (toolName === 'get_window_state') {
      this.observation += 1;
      return {
        success: true,
        structured: {
          snapshot_id: `snapshot-${this.observation}`,
          screenshot_width: 200,
          screenshot_height: 100,
          elements: [{
            element_index: 1,
            element_token: `provider-token-${this.observation}`,
            role: 'AXButton',
            label: 'Submit',
            frame: { x: 10, y: 10, w: 80, h: 20 },
          }],
        },
      };
    }
    if (!['start_session', 'end_session'].includes(toolName)) this.mutationCount += 1;
    return { success: true, output: 'ok' };
  }

  getGeneration(): string | undefined {
    return 'cua-driver:lock-events';
  }
}

function toolContext(input: {
  events: AgentEvent[];
  agentId: string;
  toolCallId: string;
}): ToolContext {
  return {
    runId: 'run-lock-events',
    sessionId: 'conversation-lock-events',
    workspace: process.cwd(),
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    agentId: input.agentId,
    currentToolCallId: input.toolCallId,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    emit(event) {
      input.events.push(event);
    },
  };
}

function surfaceEvents(events: AgentEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.type === 'surface_execution')
    .map((event) => (event as AgentEvent & { data: Record<string, unknown> }).data);
}

async function waitForLockEvent(events: AgentEvent[], action: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (surfaceEvents(events).some((event) => (
      (event.operation as Record<string, unknown> | undefined)?.action === action
    ))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${action}`);
}

async function observeState(
  handler: CuaStatefulComputerUseHandler,
  events: AgentEvent[],
): Promise<{ stateId: string; surfaceSessionId: string }> {
  const result = await handler.execute({
    operation: 'observe',
    target: { pid: 42, windowId: 7 },
  }, toolContext({ events, agentId: 'agent-a', toolCallId: 'observe-lock' }), async () => ({ allow: true }));
  if (!result.ok) throw new Error(result.error);
  return {
    stateId: (JSON.parse(result.output) as { state: { stateId: string } }).state.stateId,
    surfaceSessionId: (result.meta as { surfaceSessionId: string }).surfaceSessionId,
  };
}

describe('stateful CUA input lock Surface events', () => {
  let lockDir: string;
  let lockPath: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'cua-surface-events-'));
    lockPath = join(lockDir, 'computer-use.lock');
    process.env.CODE_AGENT_CU_LOCK_PATH = lockPath;
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_CU_LOCK_PATH;
    rmSync(lockDir, { recursive: true, force: true });
  });

  function fixture() {
    const registry = new RunRegistry();
    registry.start({
      runId: 'run-lock-events',
      sessionId: 'conversation-lock-events',
      workspace: process.cwd(),
    });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const driver = new LockAwareCuaDriver();
    const handler = new CuaStatefulComputerUseHandler(new CuaStateAdapter(driver), runtime);
    return { driver, handler, runtime };
  }

  it('projects acquire and release with the owning run, agent, and Surface session', async () => {
    const { driver, handler } = fixture();
    const events: AgentEvent[] = [];
    const observed = await observeState(handler, events);
    const acted = await handler.execute({
      operation: 'act',
      stateId: observed.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ events, agentId: 'agent-a', toolCallId: 'act-lock' }), async () => ({ allow: true }));

    expect(acted.ok).toBe(true);
    await waitForLockEvent(events, 'computer_input_lock_release');
    const lockEvents = surfaceEvents(events).filter((event) => (
      typeof (event.operation as Record<string, unknown> | undefined)?.action === 'string'
      && String((event.operation as Record<string, unknown>).action).startsWith('computer_input_lock_')
    ));
    expect(lockEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: observed.surfaceSessionId,
        runId: 'run-lock-events',
        agentId: 'agent-a',
        surface: 'computer',
        provider: 'cua-driver',
        phase: 'prepare',
        status: 'succeeded',
        operation: expect.objectContaining({ action: 'computer_input_lock_acquire' }),
      }),
      expect.objectContaining({
        sessionId: observed.surfaceSessionId,
        phase: 'cleanup',
        status: 'succeeded',
        operation: expect.objectContaining({ action: 'computer_input_lock_release' }),
      }),
    ]));
    expect(driver.mutationCount).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('projects stale-lock recovery without exposing AX tokens or filesystem paths', async () => {
    const { handler } = fixture();
    const events: AgentEvent[] = [];
    const observed = await observeState(handler, events);
    writeFileSync(lockPath, 'surface-secret-canary-corrupt-lock{{{');

    const acted = await handler.execute({
      operation: 'act',
      stateId: observed.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ events, agentId: 'agent-a', toolCallId: 'act-recover' }), async () => ({ allow: true }));

    expect(acted.ok).toBe(true);
    await waitForLockEvent(events, 'computer_input_lock_release');
    expect(surfaceEvents(events)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: observed.surfaceSessionId,
        phase: 'recover',
        status: 'succeeded',
        operation: expect.objectContaining({ action: 'computer_input_lock_recover' }),
      }),
    ]));
    const serialized = JSON.stringify(surfaceEvents(events));
    expect(serialized).not.toContain('surface-secret-canary');
    expect(serialized).not.toContain(lockPath);
    expect(serialized).not.toContain('provider-token-');
  });

  it('fails closed on a foreign live lock and does not emit the foreign owner', async () => {
    const { driver, handler } = fixture();
    const events: AgentEvent[] = [];
    const observed = await observeState(handler, events);
    const foreignOwner = 'surface-secret-canary-foreign-owner';
    writeFileSync(lockPath, JSON.stringify({
      sessionId: foreignOwner,
      pid: process.pid,
      acquiredAt: Date.now(),
      lastUsedAt: Date.now(),
    }));

    const acted = await handler.execute({
      operation: 'act',
      stateId: observed.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ events, agentId: 'agent-a', toolCallId: 'act-blocked' }), async () => ({ allow: true }));

    expect(acted).toMatchObject({ ok: false, code: 'CUA_ACTION_FAILED' });
    await waitForLockEvent(events, 'computer_input_lock_release');
    const lockEvents = surfaceEvents(events).filter((event) => (
      String((event.operation as Record<string, unknown> | undefined)?.action || '')
        .startsWith('computer_input_lock_')
    ));
    expect(lockEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: observed.surfaceSessionId,
        phase: 'prepare',
        status: 'failed',
        operation: expect.objectContaining({ action: 'computer_input_lock_acquire' }),
      }),
      expect.objectContaining({
        sessionId: observed.surfaceSessionId,
        phase: 'cleanup',
        status: 'failed',
        operation: expect.objectContaining({ action: 'computer_input_lock_release' }),
      }),
    ]));
    expect(driver.mutationCount).toBe(0);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).sessionId).toBe(foreignOwner);
    const serialized = JSON.stringify(lockEvents);
    expect(serialized).not.toContain(foreignOwner);
    expect(serialized).not.toContain(lockPath);
    expect(serialized).not.toContain('surface-secret-canary');
  });

  it('rejects a cross-agent state before permission, lock activity, or mutation', async () => {
    const { driver, handler } = fixture();
    const events: AgentEvent[] = [];
    const observed = await observeState(handler, events);
    events.splice(0);
    let permissions = 0;
    const canUseTool: CanUseToolFn = async () => {
      permissions += 1;
      return { allow: true };
    };

    const result = await handler.execute({
      operation: 'act',
      stateId: observed.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ events, agentId: 'agent-b', toolCallId: 'act-cross-agent' }), canUseTool);

    expect(result).toMatchObject({ ok: false, code: 'SURFACE_STATE_STALE' });
    expect(permissions).toBe(0);
    expect(driver.mutationCount).toBe(0);
    expect(surfaceEvents(events).some((event) => (
      String((event.operation as Record<string, unknown> | undefined)?.action || '')
        .startsWith('computer_input_lock_')
    ))).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects a lock lifecycle scope that does not match the bound Surface session', async () => {
    const { handler, runtime } = fixture();
    const events: AgentEvent[] = [];
    const observed = await observeState(handler, events);
    const binding = runtime.getComputerBinding({
      identity: {
        conversationId: 'conversation-lock-events',
        runId: 'run-lock-events',
        agentId: 'agent-a',
      },
      providerStateId: observed.stateId,
    });
    if (!binding) throw new Error('expected Computer binding');
    const before = surfaceEvents(events).length;

    expect(() => runtime.recordComputerInputLockLifecycle({
      subject: binding.subject,
      lifecycle: {
        scope: 'foreign-surface-session',
        phase: 'acquire',
        status: 'succeeded',
        outcome: 'acquired',
        occurredAt: Date.now(),
      },
    })).toThrow('does not match the owning Surface session');
    expect(surfaceEvents(events)).toHaveLength(before);
  });
});
