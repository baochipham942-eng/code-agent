import { describe, expect, it } from 'vitest';

import {
  STABLE_EVENT_TYPES,
} from '../../src/shared/contract/agent';
import {
  AgentEventEnvelopeSchema,
  AgentEventSchema,
} from '../../src/shared/contract/agentEventSchemas';

describe('AgentEventSchema', () => {
  const legalEvents = [
    { type: 'turn_start', data: { turnId: 'turn-1', iteration: 1, agentId: 'agent-1', runId: 'run-1' } },
    { type: 'turn_end', data: { turnId: 'turn-1', agentId: 'agent-1', runId: 'run-1' } },
    {
      type: 'subagent_activity',
      data: { agentId: 'agent-1', runId: 'run-1', kind: 'started' },
    },
    {
      type: 'subagent_run_end',
      data: { agentId: 'agent-1', runId: 'run-1', status: 'completed' },
    },
    { type: 'tool_call_start', data: { id: 'call-1', name: 'Read', arguments: { path: 'README.md' } } },
    { type: 'tool_call_end', data: { toolCallId: 'call-1', success: true, output: 'ok' } },
    {
      type: 'permission_request',
      data: {
        id: 'permission-1',
        type: 'file_write',
        tool: 'Write',
        details: { path: 'notes.md' },
        timestamp: 1,
      },
    },
    { type: 'artifact_locator', data: { state: 'resolved', kind: 'document', reason: 'user-selected' } },
    {
      type: 'turn_diff',
      data: {
        turnId: 'turn-1',
        agentId: 'agent-1',
        runId: 'run-1',
        parentToolUseId: 'parent-tool-1',
        files: [{
          filePath: '/repo/generated.txt',
          oldText: '',
          newText: 'line 1\nline 2',
          added: 2,
          removed: 0,
          isNewFile: true,
          editCount: 1,
        }],
      },
    },
    { type: 'agent_complete', data: null },
  ] as const;

  it('accepts representative legal events across the stable contract', () => {
    for (const sample of legalEvents) {
      expect(AgentEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it('accepts the event envelope fields without changing the event body', () => {
    expect(AgentEventEnvelopeSchema.parse({
      ...legalEvents[0],
      sessionId: 'session-1',
      seq: 7,
    })).toEqual({
      ...legalEvents[0],
      sessionId: 'session-1',
      seq: 7,
    });
  });

  it.each([
    ['unknown discriminator', { type: 'fake_event', data: null }],
    ['missing required payload field', { type: 'turn_start', data: {} }],
    ['wrong payload primitive', { type: 'tool_call_end', data: { toolCallId: 1, success: true } }],
    ['wrong null terminal payload', { type: 'agent_complete', data: {} }],
    ['wrong envelope field', { type: 'turn_end', data: { turnId: 'turn-1' }, seq: '1' }],
  ])('rejects %s', (_label, sample) => {
    expect(() => AgentEventEnvelopeSchema.parse(sample)).toThrow();
  });

  it('exports stability metadata and the stable type set from the same source', () => {
    const stabilityMetadata = AgentEventSchema.options.map((schema) => schema.meta()?.stability);
    expect(stabilityMetadata).toHaveLength(70);
    expect(stabilityMetadata.filter((stability) => stability === 'stable')).toHaveLength(12);
    expect(stabilityMetadata.filter((stability) => stability === 'experimental')).toHaveLength(58);
    expect(STABLE_EVENT_TYPES).toEqual(new Set([
      'message',
      'tool_call_start',
      'tool_call_end',
      'artifact_write_started',
      'permission_request',
      'error',
      'artifact_locator',
      'agent_complete',
      'agent_cancelled',
      'turn_start',
      'turn_end',
      'stream_usage',
    ]));
  });
});
