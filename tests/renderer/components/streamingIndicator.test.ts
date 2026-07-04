import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import {
  StreamingIndicator,
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

// 产品拍板：思考流式进行中用「正在思考…」扫光文字替代呼吸光标，思考阶段一结束
// 立刻消失，不留残影；不是思考阶段（等工具/长跑工具）保持原样。
describe('StreamingIndicator rendering', () => {
  it('shows the shimmering "正在思考…" text when isThinking is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, isThinking: true }),
    );
    expect(html).toContain('正在思考');
    expect(html).toContain('streaming-thinking-shimmer');
    // 思考态不应该再画独立的呼吸光标
    expect(html).not.toContain('streaming-caret');
  });

  it('falls back to the plain breathing caret when not thinking', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, isThinking: false }),
    );
    expect(html).not.toContain('正在思考');
    expect(html).toContain('streaming-caret');
  });

  it('hides entirely when showCaret is false, even if isThinking is true (visible text already streaming)', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, isThinking: true, showCaret: false }),
    );
    expect(html).toBe('');
  });
});
