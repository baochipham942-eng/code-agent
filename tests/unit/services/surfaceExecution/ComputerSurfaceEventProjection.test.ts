import { describe, expect, it } from 'vitest';
import type { ComputerSurfaceMode } from '../../../../src/shared/contract/desktop';
import type { SurfaceExecutionEventV1 } from '../../../../src/shared/contract/surfaceExecution';
import {
  attachComputerSurfaceModeEvent,
  createComputerSurfaceModeEvent,
} from '../../../../src/host/services/surfaceExecution/ComputerSurfaceEventProjection';
import { attachSurfaceExecutionResultProjection } from '../../../../src/host/services/surfaceExecution/surfaceExecutionResultProjection';

const identity = {
  conversationId: 'conversation-a',
  runId: 'run-a',
  turnId: 'turn-a',
  agentId: 'agent-a',
  toolCallId: 'tool-a',
};

describe('Computer Surface compatibility mode events', () => {
  it.each<{
    mode: ComputerSurfaceMode;
    status: SurfaceExecutionEventV1['status'];
    summary: string;
  }>([
    {
      mode: 'foreground_fallback',
      status: 'succeeded',
      summary: 'Selected foreground Computer input fallback',
    },
    {
      mode: 'background_ax',
      status: 'succeeded',
      summary: 'Selected background Accessibility input',
    },
    {
      mode: 'background_cgevent',
      status: 'succeeded',
      summary: 'Selected background window-local pointer input',
    },
    {
      mode: 'background_surface_unavailable',
      status: 'failed',
      summary: 'Background Computer input is unavailable',
    },
  ])('maps $mode to a safe V1 prepare event', ({ mode, status, summary }) => {
    const event = createComputerSurfaceModeEvent({ mode, identity, occurredAt: 123 });
    expect(event).toMatchObject({
      version: 1,
      eventId: 'computer-surface-mode:tool-a',
      sequence: 1,
      sessionId: 'legacy-surface:tool-a',
      conversationId: 'conversation-a',
      runId: 'run-a',
      turnId: 'turn-a',
      agentId: 'agent-a',
      surface: 'computer',
      provider: 'computer-surface-compat',
      phase: 'prepare',
      status,
      userSummary: summary,
      operation: {
        action: 'select_computer_surface_mode',
        risk: 'input',
        approvalScope: mode,
      },
      startedAt: 123,
      completedAt: 123,
    });
  });

  it('prepends the selected mode to the normal compatibility terminal event', () => {
    const modeEvent = createComputerSurfaceModeEvent({
      mode: 'background_ax',
      identity,
      occurredAt: 100,
    });
    const result = attachComputerSurfaceModeEvent({
      success: true,
      output: 'ok',
      metadata: {
        artifactRef: '/Users/example/surface-secret-canary-output.txt',
      },
    }, modeEvent);
    const projected = attachSurfaceExecutionResultProjection({
      toolName: 'computer_use',
      arguments: {
        action: 'click',
        axPath: 'AXApplication/AXWindow/AXButton[private]',
        text: 'surface-secret-canary-input',
      },
      result,
      conversationId: identity.conversationId,
      runId: identity.runId,
      turnId: identity.turnId,
      agentId: identity.agentId,
      toolCallId: identity.toolCallId,
      startedAt: 100,
      completedAt: 200,
    });

    const events = projected.metadata?.surfaceExecutionEventsV1 as SurfaceExecutionEventV1[];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sequence: 1,
      phase: 'prepare',
      operation: { action: 'select_computer_surface_mode', approvalScope: 'background_ax' },
    });
    expect(events[1]).toMatchObject({
      sequence: 2,
      phase: 'act',
      status: 'succeeded',
      operation: { action: 'click' },
    });
    expect(projected.metadata?.surfaceExecutionEventV1).toEqual(events[1]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('surface-secret-canary');
    expect(serialized).not.toContain('/Users/example');
    expect(serialized).not.toContain('AXApplication/AXWindow');
  });

  it('requires complete owner identity and ignores a foreign injected mode event', () => {
    expect(createComputerSurfaceModeEvent({
      mode: 'foreground_fallback',
      identity: { ...identity, agentId: undefined },
    })).toBeNull();
    const owned = createComputerSurfaceModeEvent({ mode: 'foreground_fallback', identity });
    if (!owned) throw new Error('expected owned mode event');
    const result = attachComputerSurfaceModeEvent({ success: true }, {
      ...owned,
      agentId: 'agent-b',
    });
    const projected = attachSurfaceExecutionResultProjection({
      toolName: 'computer_use',
      arguments: { action: 'click' },
      result,
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      toolCallId: identity.toolCallId,
      startedAt: 100,
      completedAt: 200,
    });

    expect(projected.metadata?.surfaceExecutionEventsV1).toHaveLength(1);
    expect(projected.metadata?.surfaceExecutionEventV1).toMatchObject({
      sequence: 1,
      agentId: 'agent-a',
      operation: { action: 'click' },
    });
  });
});
