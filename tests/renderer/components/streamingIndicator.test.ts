import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import {
  StreamingIndicator,
  getRunningSubagentCount,
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
// 2026-08 P1「信号词库」：回响信号（等模型）/ 编队信号（等子任务，带真实并发数）。
describe('StreamingIndicator waiting reason (具名等待)', () => {
  it('renders the echo-signal label instead of the bare caret while awaiting the model', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'model' }),
    );
    expect(html).toContain('信号传输中，正在等待模型回响');
    expect(html).not.toContain('streaming-caret');
  });

  it('renders the fleet-signal label without a count when only one subtask is running', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'subagent', subagentCount: 1 }),
    );
    expect(html).toContain('编队作业中，子舰并行中');
    expect(html).not.toContain('streaming-caret');
  });

  it('renders the fleet-signal label with the real concurrency count when ≥2 subtasks run', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, { startTime: 100, waitingReason: 'subagent', subagentCount: 3 }),
    );
    expect(html).toContain('编队作业中，3 艘子舰并行');
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

// 巡航信号（长任务 ≥45s）：中性陈述「链路正常」，秒表沿用现有逻辑，只改文案。
describe('StreamingIndicator cruise signal (长任务)', () => {
  it('renders the deep-space cruise copy with the stopwatch once a tool runs ≥45s', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, {
        startTime: 100,
        runningToolStartTime: Date.now() - 46_000,
      }),
    );
    expect(html).toContain('深空巡航中');
    expect(html).toContain('链路正常');
    // 秒表仍在（mm:ss），中性色，不含警告色类名
    expect(html).toMatch(/font-mono[^>]*>\d+:\d{2}</);
    expect(html).not.toContain('text-amber');
    expect(html).not.toContain('text-red');
  });

  it('keeps the plain breathing caret below the 45s threshold', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingIndicator, {
        startTime: 100,
        runningToolStartTime: Date.now() - 20_000,
      }),
    );
    expect(html).not.toContain('深空巡航中');
    expect(html).toContain('streaming-caret');
  });
});

// 真实并发子任务数：与等待具名同一判定——只数仍在运行的子 agent 阻塞类工具调用。
describe('getRunningSubagentCount', () => {
  const toolNode = (id: string, name: string, done = false): TraceNode => ({
    id,
    type: 'tool_call',
    content: '',
    timestamp: 100,
    toolCall: done
      ? { id, name, args: {}, success: true }
      : { id, name, args: {} },
  });

  it('counts only still-running subagent blocking tools', () => {
    const nodes: TraceNode[] = [
      toolNode('a', 'spawn_agent'),
      toolNode('b', 'task'),
      toolNode('c', 'collect_agent', true), // 已完成，不计
      toolNode('d', 'Bash'), // 普通工具，不计
    ];

    expect(getRunningSubagentCount(nodes)).toBe(2);
  });

  it('returns 0 when no subagent tool is running', () => {
    expect(getRunningSubagentCount([])).toBe(0);
    expect(getRunningSubagentCount([toolNode('a', 'spawn_agent', true)])).toBe(0);
  });
});
