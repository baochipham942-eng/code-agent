import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import {
  getRunningToolStartTime,
  getStreamingIndicatorState,
} from '../../../src/renderer/components/features/chat/StreamingIndicator';

describe('StreamingIndicator state', () => {
  it('stays in calm active mode when no tool is running, regardless of turn duration', () => {
    // 健康的长生成（哪怕跑了很久）不算异常 —— 不升级、不报警
    const state = getStreamingIndicatorState(undefined);

    expect(state.mode).toBe('active');
    expect(state.longRunningTool).toBe(false);
  });

  it('stays in active mode while a running tool is still fresh', () => {
    const state = getStreamingIndicatorState(20);

    expect(state.mode).toBe('active');
    expect(state.longRunningTool).toBe(false);
  });

  it('surfaces the calm long-tool notice only after a tool genuinely runs long', () => {
    const state = getStreamingIndicatorState(46);

    expect(state.mode).toBe('long-tool');
    expect(state.longRunningTool).toBe(true);
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
