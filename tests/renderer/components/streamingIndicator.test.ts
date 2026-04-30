import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import {
  getRunningToolStartTime,
  getStreamingIndicatorState,
} from '../../../src/renderer/components/features/chat/StreamingIndicator';

describe('StreamingIndicator state', () => {
  it('does not show the stuck phase for a long turn while no tool is running', () => {
    const state = getStreamingIndicatorState(409 * 60 + 10);

    expect(state.phase.label).toBe('处理时间较长...');
    expect(state.isStuck).toBe(false);
  });

  it('does not show the stuck phase when the turn is old but the running tool is fresh', () => {
    const state = getStreamingIndicatorState(120, 20);

    expect(state.phase.label).toBe('处理时间较长...');
    expect(state.isStuck).toBe(false);
  });

  it('shows the stuck phase only after a running tool crosses the stuck threshold', () => {
    const state = getStreamingIndicatorState(120, 91);

    expect(state.phase.label).toBe('工具可能卡住');
    expect(state.isStuck).toBe(true);
  });

  it('uses the oldest live tool execution start and ignores preparing or completed tools', () => {
    const nodes: TraceNode[] = [
      {
        id: 'tool-preparing',
        type: 'tool_call',
        content: '',
        timestamp: 100,
        toolCall: {
          id: 'preparing',
          name: 'Read',
          args: {},
          _streaming: true,
        },
      },
      {
        id: 'tool-completed',
        type: 'tool_call',
        content: '',
        timestamp: 120,
        toolCall: {
          id: 'completed',
          name: 'Bash',
          args: {},
          success: true,
        },
      },
      {
        id: 'tool-running',
        type: 'tool_call',
        content: '',
        timestamp: 150,
        toolCall: {
          id: 'running',
          name: 'computer_use',
          args: {},
        },
      },
    ];

    expect(getRunningToolStartTime(nodes)).toBe(150);
  });
});
