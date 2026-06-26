import { describe, expect, it } from 'vitest';

import { TrajectoryBuilder } from '../../../src/host/evaluation/trajectory/trajectoryBuilder';
import type { AgentPointerEvent } from '../../../src/shared/contract/desktop';

describe('TrajectoryBuilder Agent Pointer evidence', () => {
  it('attaches tool_call_end Agent Pointer metadata to the paired trajectory step', () => {
    const pointerEvent: AgentPointerEvent = {
      id: 'pointer-builder',
      surface: 'computer',
      tone: 'computer',
      phase: 'click',
      coordSpace: 'windowLocal',
      point: { x: 320, y: 180, unit: 'px' },
      targetLabel: 'Send',
      targetSource: 'axPath',
      traceId: 'trace-builder',
      success: true,
    };

    const trajectory = new TrajectoryBuilder().buildFromEvents([
      {
        event_type: 'tool_call_start',
        event_data: {
          id: 'call-1',
          name: 'computer_use',
          args: { action: 'click', targetApp: 'Notes' },
        },
        timestamp: '100',
      },
      {
        event_type: 'tool_call_end',
        event_data: {
          toolCallId: 'call-1',
          name: 'computer_use',
          success: true,
          duration: 25,
          result: 'Clicked Send',
          metadata: {
            agentPointerEvent: pointerEvent,
          },
        },
        timestamp: '125',
      },
    ]);

    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.toolCall).toMatchObject({
      name: 'computer_use',
      success: true,
      duration: 25,
      result: 'Clicked Send',
      agentPointerEvent: {
        id: 'pointer-builder',
        targetLabel: 'Send',
        traceId: 'trace-builder',
      },
    });
  });

  it('keeps the full Agent Pointer timeline on the trajectory step', () => {
    const timeline: AgentPointerEvent[] = [{
      id: 'pointer-click',
      surface: 'browser',
      tone: 'browser',
      phase: 'click',
      coordSpace: 'browserViewport',
      point: { x: 12, y: 24, unit: 'px' },
      targetLabel: 'Open',
      targetSource: 'targetRef',
      success: true,
    }, {
      id: 'pointer-scroll',
      surface: 'browser',
      tone: 'browser',
      phase: 'scroll',
      coordSpace: 'browserViewport',
      point: { x: 44, y: 88, unit: 'px' },
      targetLabel: 'Results',
      targetSource: 'selector',
      success: true,
    }];

    const trajectory = new TrajectoryBuilder().buildFromEvents([
      {
        event_type: 'tool_call_start',
        event_data: {
          id: 'call-2',
          name: 'browser_action',
          args: { action: 'scroll' },
        },
        timestamp: '200',
      },
      {
        event_type: 'tool_call_end',
        event_data: {
          toolCallId: 'call-2',
          name: 'browser_action',
          success: true,
          metadata: {
            agentPointerTimeline: timeline,
          },
        },
        timestamp: '230',
      },
    ]);

    expect(trajectory.steps[0]?.toolCall?.agentPointerEvent?.id).toBe('pointer-click');
    expect(trajectory.steps[0]?.toolCall?.agentPointerTimeline?.map((event) => event.id)).toEqual([
      'pointer-click',
      'pointer-scroll',
    ]);
  });
});
