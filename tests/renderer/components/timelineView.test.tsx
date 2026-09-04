// @vitest-environment jsdom
// TimelineView 折叠：真机一条 4 轮 CLI 会话有 8411 条事件，其中 8204 条摘要是写死的
// 「Thinking...」——不折叠就是 8411 个 DOM 行、42 万像素高，真正有信息的 18 条全被埋掉。
import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import type { TelemetryTimelineEvent } from '../../../src/shared/contract/telemetry';
import { TimelineView } from '@internal-evaluation/renderer/telemetry/TimelineView';

vi.mock('@internal-evaluation/renderer/i18n/useEvaluationI18n', () => ({
  useEvaluationI18n: () => ({
    t: {
      telemetry: {
        emptyEvents: '暂无事件数据',
        eventRepeat: '× {n}',
        eventSpan: '{s}s',
        eventNames: {
          task_progress: '任务进度',
          message_delta: '流式输出',
          stream_reasoning: '模型思考',
        } as Record<string, string>,
      },
    },
  }),
}));

function event(partial: Partial<TelemetryTimelineEvent> & { id: string; timestamp: number }): TelemetryTimelineEvent {
  return {
    turnId: 'turn-1',
    sessionId: 'session-1',
    eventType: 'message_delta',
    summary: 'Thinking...',
    ...partial,
  } as TelemetryTimelineEvent;
}

afterEach(cleanup);

function rowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.space-y-0\\.5 > div')].map((row) => (row.textContent ?? '').trim());
}

describe('时间线折叠', () => {
  it('把连续同类同摘要的事件折叠成一条，并显示条数与时间跨度', () => {
    const { container } = render(<TimelineView events={[
      event({ id: 'a', timestamp: 1_000 }),
      event({ id: 'b', timestamp: 3_500 }),
      event({ id: 'c', timestamp: 6_000 }),
      event({ id: 'd', timestamp: 7_000, eventType: 'tool_call_start', summary: 'Tool: Read started' }),
    ]} />);

    const rows = rowTexts(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('× 3');
    expect(rows[0]).toContain('5.0s');
    expect(rows[1]).toContain('Tool: Read started');
    expect(rows[1]).not.toContain('×');
  });

  it('摘要不同就不折叠——同类事件里有真内容的那条不能被吃掉', () => {
    const { container } = render(<TimelineView events={[
      event({ id: 'a', timestamp: 1_000 }),
      event({ id: 'b', timestamp: 2_000, summary: 'Streaming response...' }),
      event({ id: 'c', timestamp: 3_000 }),
    ]} />);

    expect(rowTexts(container)).toHaveLength(3);
  });

  it('中间隔了别的事件就分成两组，不跨组合并', () => {
    const { container } = render(<TimelineView events={[
      event({ id: 'a', timestamp: 1_000 }),
      event({ id: 'b', timestamp: 2_000, eventType: 'message', summary: 'Message: hi' }),
      event({ id: 'c', timestamp: 3_000 }),
      event({ id: 'd', timestamp: 4_000 }),
    ]} />);

    const rows = rowTexts(container);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('× 2');
  });
});

describe('TimelineView', () => {
  it('8000 条 Thinking 只渲染一行，带条数与跨度', () => {
    const events = Array.from({ length: 8_000 }, (_, i) => event({ id: `e${i}`, timestamp: 1_000 + i * 10 }));
    const { container } = render(<TimelineView events={events} />);

    expect(container.querySelectorAll('.space-y-0\\.5 > div')).toHaveLength(1);
    expect(screen.getByText('× 8000')).toBeTruthy();
    // 「Thinking...」是采集侧写死的占位，中文界面里换成事件名
    expect(screen.getByText(/模型思考/)).toBeTruthy();
    expect(screen.getByText('80.0s')).toBeTruthy();
  });

  it('摘要是「Event: <type>」时（= 采集侧没写摘要）换成事件名人话，有真摘要的原样保留', () => {
    render(<TimelineView events={[
      event({ id: 'a', timestamp: 1_000, eventType: 'task_progress', summary: 'Event: task_progress' }),
      event({ id: 'b', timestamp: 2_000, eventType: 'model_decision', summary: 'Model decision: glm -> glm' }),
      event({ id: 'c', timestamp: 3_000, eventType: 'stream_usage', summary: 'Event: stream_usage' }),
    ]} />);

    expect(screen.getByText('任务进度')).toBeTruthy();
    expect(screen.getByText('Model decision: glm -> glm')).toBeTruthy();
    // 词表没收录的类型：至少把无意义的 'Event: ' 前缀去掉
    expect(screen.getByText('stream_usage')).toBeTruthy();
  });

  it('空事件给空态', () => {
    render(<TimelineView events={[]} />);
    expect(screen.getByText('暂无事件数据')).toBeTruthy();
  });
});
