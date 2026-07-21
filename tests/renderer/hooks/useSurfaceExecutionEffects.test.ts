import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@shared/contract/message';
import type { SurfaceConversationSnapshotV1, SurfaceExecutionEventV1 } from '@shared/contract/surfaceExecution';
import {
  buildSurfaceExecutionCompatibilityEnvelopes,
  createSurfaceSnapshotRefreshCoordinator,
  getSurfaceExecutionConversationId,
} from '@renderer/hooks/agent/effects/useSurfaceExecutionEffects';

function surfaceEvent(overrides: Partial<SurfaceExecutionEventV1> = {}): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 1,
    sessionId: 'surface-session-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    agentId: 'agent-1',
    surface: 'browser',
    provider: 'managed',
    sessionState: 'running',
    phase: 'observe',
    status: 'running',
    userSummary: 'Checked the page',
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'stop'],
    startedAt: 10,
    ...overrides,
  };
}

function message(
  id: string,
  event: SurfaceExecutionEventV1,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 10,
    metadata: {
      agentTeam: {
        sessionId: 'conversation-1',
        runId: 'outer-run',
        treeId: 'tree-1',
        agentId: 'outer-agent',
      },
    },
    toolResults: [{
      toolCallId: `tool-${id}`,
      success: true,
      metadata: { surfaceExecutionEventV1: event },
    }],
    ...overrides,
  };
}

function snapshot(conversationId: string, updatedAt: number): SurfaceConversationSnapshotV1 {
  return { version: 1, conversationId, sessions: [], updatedAt };
}

describe('Surface Execution renderer effects', () => {
  it('uses the outer Agent envelope sessionId as conversation identity', () => {
    const event = surfaceEvent();
    expect(getSurfaceExecutionConversationId({
      type: 'surface_execution',
      sessionId: 'conversation-1',
      data: event,
    })).toBe('conversation-1');
    expect(getSurfaceExecutionConversationId({
      type: 'surface_execution',
      data: event,
    })).toBeNull();
  });

  it('rejects a payload conversation mismatch instead of crossing sessions', () => {
    expect(getSurfaceExecutionConversationId({
      type: 'surface_execution',
      sessionId: 'conversation-2',
      data: surfaceEvent(),
    })).toBeNull();
  });

  it('projects active ToolResults and attached results while excluding rewound history', () => {
    const activeEvent = surfaceEvent({ eventId: 'active' });
    const attachedEvent = surfaceEvent({ eventId: 'attached' });
    const attached = message('attached-message', attachedEvent, {
      toolResults: [],
      toolCalls: [{
        id: 'attached-call',
        name: 'browser_action',
        arguments: {},
        result: {
          toolCallId: 'attached-call',
          success: true,
          metadata: { surfaceExecutionEventV1: attachedEvent },
        },
      }],
    });
    const envelopes = buildSurfaceExecutionCompatibilityEnvelopes('conversation-1', [
      message('active-message', activeEvent),
      message('rewound-message', surfaceEvent({ eventId: 'rewound' }), { visibility: 'rewound' }),
      attached,
    ]);

    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((item) => item.toolResults[0].toolCallId)).toEqual([
      'tool-active-message',
      'attached-call',
    ]);
    expect(envelopes[0]).toMatchObject({ runId: 'outer-run', agentId: 'outer-agent' });
  });

  it('does not let a stale request overwrite a newer conversation snapshot', async () => {
    const resolvers: Array<(value: SurfaceConversationSnapshotV1) => void> = [];
    const accepted: number[] = [];
    const fetchSnapshot = vi.fn((conversationId: string) => (
      new Promise<SurfaceConversationSnapshotV1>((resolve) => {
        expect(conversationId).toBe('conversation-1');
        resolvers.push(resolve);
      })
    ));
    const coordinator = createSurfaceSnapshotRefreshCoordinator({
      fetchSnapshot,
      acceptSnapshot: (_conversationId, value) => {
        accepted.push((value as SurfaceConversationSnapshotV1).updatedAt);
        return true;
      },
    });

    const older = coordinator.refresh('conversation-1');
    const newer = coordinator.refresh('conversation-1');
    resolvers[1](snapshot('conversation-1', 20));
    await expect(newer).resolves.toBe(true);
    resolvers[0](snapshot('conversation-1', 10));
    await expect(older).resolves.toBe(false);
    expect(accepted).toEqual([20]);
  });
});
