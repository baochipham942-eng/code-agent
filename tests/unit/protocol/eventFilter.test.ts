import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_AGENT_EXPERIMENTAL_EVENT_TYPES,
  BACKGROUND_AGENT_EVENT_FILTER,
  shouldDeliverAgentEvent,
} from '../../../src/host/protocol/events/eventFilter';

describe('AgentEvent filters', () => {
  it('defaults to the full event stream', () => {
    expect(shouldDeliverAgentEvent('message_delta')).toBe(true);
    expect(shouldDeliverAgentEvent('permission_request')).toBe(true);
  });

  it('applies include before exclude', () => {
    const filter = {
      include: ['turn_end', 'permission_request'] as const,
      exclude: ['turn_end'] as const,
    };
    expect(shouldDeliverAgentEvent('message_delta', filter)).toBe(false);
    expect(shouldDeliverAgentEvent('turn_end', filter)).toBe(false);
    expect(shouldDeliverAgentEvent('permission_request', filter)).toBe(true);
  });

  it('channel and unattended consumers reject deltas but retain permission requests', () => {
    expect(shouldDeliverAgentEvent('message_delta', BACKGROUND_AGENT_EVENT_FILTER)).toBe(false);
    expect(shouldDeliverAgentEvent('stream_chunk', BACKGROUND_AGENT_EVENT_FILTER)).toBe(false);
    expect(shouldDeliverAgentEvent('permission_request', BACKGROUND_AGENT_EVENT_FILTER)).toBe(true);
    expect(shouldDeliverAgentEvent('turn_end', BACKGROUND_AGENT_EVENT_FILTER)).toBe(true);
    expect(shouldDeliverAgentEvent('tool_call_end', BACKGROUND_AGENT_EVENT_FILTER)).toBe(true);
    expect(shouldDeliverAgentEvent('artifact_locator', BACKGROUND_AGENT_EVENT_FILTER)).toBe(true);
    expect(shouldDeliverAgentEvent('turn_diff', BACKGROUND_AGENT_EVENT_FILTER)).toBe(true);
  });

  it('keeps the unattended allowlist behavior stable while sourcing its stable segment from the schema', () => {
    expect([...BACKGROUND_AGENT_EVENT_FILTER.include ?? []].sort()).toEqual([
      'agent_cancelled',
      'agent_complete',
      'artifact_locator',
      'artifact_write_started',
      'error',
      'permission_request',
      'tool_call_end',
      'turn_diff',
      'turn_end',
      'turn_start',
    ]);
    expect(BACKGROUND_AGENT_EXPERIMENTAL_EVENT_TYPES).toEqual(['turn_diff']);
  });
});
