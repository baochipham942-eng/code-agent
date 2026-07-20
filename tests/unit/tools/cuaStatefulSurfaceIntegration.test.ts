import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import type {
  CanUseToolFn,
  ToolContext,
} from '../../../src/host/protocol/tools';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../../src/host/mcp/cuaStateAdapter';
import { CuaStatefulComputerUseHandler } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SurfaceExecutionRuntime } from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

class SurfaceFakeCuaDriver implements CuaDriverPort {
  readonly calls: Array<{ toolName: string; context: CuaDriverCallContext }> = [];
  private observation = 0;

  async call(
    toolName: string,
    _args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    this.calls.push({ toolName, context });
    if (toolName === 'list_windows') {
      return {
        success: true,
        structured: {
          windows: [{
            pid: 42,
            window_id: 7,
            app_name: 'Notes',
            title: 'Surface draft',
            is_on_screen: true,
            on_current_space: true,
          }],
        },
      };
    }
    if (toolName === 'get_window_state') {
      this.observation += 1;
      const complete = this.observation > 1;
      return {
        success: true,
        structured: {
          snapshot_id: `snapshot-${this.observation}`,
          screenshot_width: 200,
          screenshot_height: 100,
          elements: [{
            element_index: 1,
            element_token: `token-${this.observation}`,
            role: 'AXButton',
            label: complete ? 'Complete' : 'Submit',
            frame: { x: 10, y: 10, w: 80, h: 20 },
          }],
        },
        screenshot: {
          data: Buffer.from(`surface-${this.observation}`).toString('base64'),
          mimeType: 'image/png',
        },
      };
    }
    return { success: true, output: 'ok' };
  }

  getGeneration(): string | undefined {
    return 'cua-driver:test-generation';
  }
}

function toolContext(input: {
  runId?: string;
  agentId?: string;
  events: AgentEvent[];
  toolCallId: string;
}): ToolContext {
  return {
    runId: input.runId,
    sessionId: 'conversation-1',
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

describe('cua_stateful_computer_use Surface integration', () => {
  it('routes observe and act through owner, grant, freshness, and successor semantics', async () => {
    const registry = new RunRegistry();
    registry.start({
      runId: 'run-1',
      sessionId: 'conversation-1',
      workspace: process.cwd(),
    });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const driver = new SurfaceFakeCuaDriver();
    const handler = new CuaStatefulComputerUseHandler(new CuaStateAdapter(driver), runtime);
    const events: AgentEvent[] = [];
    const permissions: Array<Record<string, unknown>> = [];
    const canUseTool: CanUseToolFn = async (_tool, args) => {
      permissions.push(args);
      return { allow: true };
    };

    const observed = await handler.execute({
      operation: 'observe',
      target: { pid: 42, windowId: 7 },
    }, toolContext({ runId: 'run-1', agentId: 'agent-a', events, toolCallId: 'observe-1' }), canUseTool);

    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error(observed.error);
    const observedResponse = JSON.parse(observed.output) as {
      operation: string;
      state: { stateId: string };
    };
    const observedMeta = observed.meta as Record<string, unknown>;
    expect(observedMeta.surfaceExecutionSessionV1).toMatchObject({
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-a',
      surface: 'computer',
      provider: 'cua-driver',
    });
    expect(observedMeta.surfaceObservationV1).toMatchObject({
      target: {
        kind: 'computer',
        appName: 'Notes',
        pid: 42,
      },
      lifecycle: 'fresh',
    });
    const target = (observedMeta.surfaceObservationV1 as {
      target: { windowRef: string };
    }).target;
    expect(target.windowRef).toMatch(/^cua-window:[a-f0-9]{24}$/);
    expect(target.windowRef).not.toContain('7');

    const acted = await handler.execute({
      operation: 'act',
      stateId: observedResponse.state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
      expect: { kind: 'text_present', text: 'Complete' },
    }, toolContext({ runId: 'run-1', agentId: 'agent-a', events, toolCallId: 'act-1' }), canUseTool);

    expect(acted.ok).toBe(true);
    if (!acted.ok) throw new Error(acted.error);
    expect(acted.meta).toMatchObject({
      computerUseActionResultV1: {
        delivery: 'confirmed',
        verification: 'satisfied',
        overall: 'succeeded',
      },
      surfaceExecutionActionResultV1: {
        operationId: 'act-1',
        delivery: 'confirmed',
        verification: 'satisfied',
        overall: 'succeeded',
      },
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.surfaceTarget).toMatchObject({
      kind: 'computer',
      appName: 'Notes',
      windowRef: target.windowRef,
    });
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(1);
    expect(driver.calls.find((call) => call.toolName === 'click')?.context).toMatchObject({
      sessionId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-a',
    });
    expect(events.filter((event) => event.type === 'surface_execution').length).toBeGreaterThanOrEqual(4);
  });

  it('rejects cross-agent and ownerless mutations before permission or delivery', async () => {
    const registry = new RunRegistry();
    registry.start({
      runId: 'run-1',
      sessionId: 'conversation-1',
      workspace: process.cwd(),
    });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const driver = new SurfaceFakeCuaDriver();
    const handler = new CuaStatefulComputerUseHandler(new CuaStateAdapter(driver), runtime);
    const events: AgentEvent[] = [];
    let permissionCalls = 0;
    const canUseTool: CanUseToolFn = async () => {
      permissionCalls += 1;
      return { allow: true };
    };
    const observed = await handler.execute({
      operation: 'observe',
      target: { pid: 42, windowId: 7 },
    }, toolContext({ runId: 'run-1', agentId: 'agent-a', events, toolCallId: 'observe-1' }), canUseTool);
    if (!observed.ok) throw new Error(observed.error);
    const stateId = (JSON.parse(observed.output) as { state: { stateId: string } }).state.stateId;

    const crossAgent = await handler.execute({
      operation: 'act',
      stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ runId: 'run-1', agentId: 'agent-b', events, toolCallId: 'act-b' }), canUseTool);
    const ownerless = await handler.execute({
      operation: 'act',
      stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, toolContext({ events, toolCallId: 'act-ownerless' }), canUseTool);

    expect(crossAgent).toMatchObject({ ok: false, code: 'SURFACE_STATE_STALE' });
    expect(ownerless).toMatchObject({ ok: false, code: 'SURFACE_TARGET_NOT_OWNED' });
    expect(permissionCalls).toBe(0);
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
  });
});
