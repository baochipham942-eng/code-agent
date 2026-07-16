import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import {
  StreamingIndicator,
  getRunningToolStartTime,
  getStreamingIndicatorState,
  getStreamingWaitingReason,
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

// Grok Build 借鉴 T1：等待期具名——空窗期点名在等谁，静态文字、无计时器。
describe('StreamingIndicator waiting reason (具名等待)', () => {
  it('renders the named model-wait label instead of the bare caret', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'model' }),
    );
    expect(html).toContain('正在等待模型响应');
    expect(html).not.toContain('streaming-caret');
  });

  it('renders the named subagent-wait label', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'subagent' }),
    );
    expect(html).toContain('正在等待子任务');
    expect(html).not.toContain('streaming-caret');
  });

  it('stays hidden while visible text is streaming (showCaret=false), waitingReason or not', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'model', showCaret: false }),
    );
    expect(html).toBe('');
  });

  it('derives "model" only from the drafting state and "subagent" only from a running subagent tool', () => {
    const runningSubagent: TraceNode[] = [
      {
        id: 'spawn',
        type: 'tool_call',
        content: '',
        timestamp: 100,
        toolCall: { id: 'spawn', name: 'spawn_agent', args: {} },
      },
    ];
    const runningBash: TraceNode[] = [
      {
        id: 'bash',
        type: 'tool_call',
        content: '',
        timestamp: 100,
        toolCall: { id: 'bash', name: 'Bash', args: {} },
      },
    ];

    expect(getStreamingWaitingReason([], 'drafting')).toBe('model');
    expect(getStreamingWaitingReason(runningSubagent, 'using_tools')).toBe('subagent');
    expect(getStreamingWaitingReason(runningSubagent, 'waiting_tool')).toBe('subagent');
    // 普通工具运行中：不具名（维持现状，45s 长跑提示另有通道）
    expect(getStreamingWaitingReason(runningBash, 'using_tools')).toBeUndefined();
    // 非 drafting/工具态（如 idle/completed）不给理由
    expect(getStreamingWaitingReason([], 'idle')).toBeUndefined();
    expect(getStreamingWaitingReason([], 'completed')).toBeUndefined();
  });
});
