// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';

function receiptNode(): TraceNode {
  return {
    id: 'turn-receipts',
    type: 'turn_timeline',
    content: '',
    timestamp: 1_700_000_000_000,
    turnTimeline: {
      id: 'turn-receipts',
      kind: 'artifact_ownership',
      timestamp: 1_700_000_000_000,
      tone: 'success',
      artifactOwnership: [
        {
          kind: 'artifact',
          role: 'receipt',
          label: '已发送邮件：周报',
          ownerKind: 'tool',
          ownerLabel: 'mail_send',
          artifactId: 'receipt-success',
          receipt: {
            status: 'succeeded',
            summary: '已发送邮件：周报',
            detail: 'To: zhang@example.com, li@example.com, wang@example.com',
            sourceTool: 'mail_send',
            connector: 'mail',
            recipient: { first: 'zhang@example.com', count: 3 },
          },
        },
        {
          kind: 'artifact',
          role: 'receipt',
          label: '创建日历事件失败：评审会',
          ownerKind: 'tool',
          ownerLabel: 'calendar_create_event',
          artifactId: 'receipt-failed',
          receipt: {
            status: 'failed',
            summary: '创建日历事件失败：评审会',
            detail: 'Calendar create failed: service unavailable',
            sourceTool: 'calendar_create_event',
            connector: 'calendar',
          },
        },
        {
          kind: 'artifact',
          role: 'receipt',
          label: '已创建提醒事项：交材料',
          ownerKind: 'tool',
          ownerLabel: 'reminders_create',
          artifactId: 'receipt-reminder',
          receipt: {
            status: 'succeeded',
            summary: '已创建提醒事项：交材料',
            sourceTool: 'reminders_create',
            connector: 'reminders',
          },
        },
      ],
    },
  };
}

function tmeetToolNode(
  id: string,
  stepLabel: 'tmeetMeetingListUpcoming' | 'tmeetMeetingListEnded',
  result: 'running' | 'succeeded' | 'failed',
): TraceNode {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp: 1_777_244_700_000,
    toolCall: {
      id: `call-${id}`,
      name: 'tmeetMeetingList',
      args: { scope: stepLabel === 'tmeetMeetingListEnded' ? 'ended' : 'upcoming' },
      stepLabel,
      ...(result === 'running' ? {} : {
        result: result === 'succeeded' ? '{"meetings":[]}' : 'service unavailable',
        success: result === 'succeeded',
      }),
    },
  };
}

function tmeetReceiptNode(): TraceNode {
  const node = receiptNode();
  return {
    ...node,
    id: 'turn-tmeet-artifacts',
    timestamp: 1_777_244_700_000,
    turnTimeline: {
      ...node.turnTimeline!,
      id: 'turn-tmeet-artifacts',
      timestamp: 1_777_244_700_000,
      artifactOwnership: [
        {
          kind: 'artifact',
          role: 'receipt',
          label: '待开始/进行中的腾讯会议',
          ownerKind: 'tool',
          ownerLabel: 'tmeetMeetingList',
          artifactId: 'receipt-upcoming',
          sourceNodeId: 'tool-upcoming',
          receipt: {
            status: 'succeeded',
            summary: '待开始/进行中的腾讯会议',
            detail: '{"scope":"upcoming","meetings":[]}',
            sourceTool: 'tmeetMeetingList',
            connector: 'tmeet',
          },
        },
        {
          kind: 'artifact',
          role: 'receipt',
          label: '已结束的腾讯会议',
          ownerKind: 'tool',
          ownerLabel: 'tmeetMeetingList',
          artifactId: 'receipt-ended',
          sourceNodeId: 'tool-ended',
          receipt: {
            status: 'failed',
            summary: '已结束的腾讯会议',
            detail: 'service unavailable',
            sourceTool: 'tmeetMeetingList',
            connector: 'tmeet',
          },
        },
      ],
    },
  };
}

function tmeetTurn(
  phase: 'running' | 'completed' | 'persistence-gap' | 'persisted',
): TraceTurn {
  const terminal = phase === 'completed' || phase === 'persisted';
  const includeReceipts = phase !== 'running' && phase !== 'persistence-gap';
  return {
    turnNumber: 1,
    turnId: 'turn-tmeet',
    nodes: [
      tmeetToolNode('tool-upcoming', 'tmeetMeetingListUpcoming', terminal ? 'succeeded' : 'running'),
      tmeetToolNode('tool-ended', 'tmeetMeetingListEnded', terminal ? 'failed' : 'running'),
      ...(includeReceipts ? [tmeetReceiptNode()] : []),
    ],
    status: phase === 'running' || phase === 'persistence-gap' ? 'streaming' : 'completed',
    startTime: 1_777_244_640_000,
    endTime: phase === 'running' ? undefined : 1_777_244_700_000,
  };
}

describe('聊天流回执并入步骤组', () => {
  beforeEach(() => useAppStore.setState({ language: 'zh' }));
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });

  it('有步骤组时不建独立回执块，展开行同行显示状态、连接器、时间和原始回执', () => {
    const { container } = render(<TurnCard turn={tmeetTurn('completed')} />);

    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    expect(screen.queryByTestId('turn-receipts-list')).toBeNull();
    fireEvent.click(screen.getAllByRole('button')[0]!);

    expect(container.textContent).toContain('查了待开始/进行中的会议');
    expect(container.textContent).toContain('查询近 30 天已结束的会议未成功');
    expect(container.textContent).not.toContain('查了近 30 天已结束的会议');
    // 时间按本机时区格式化（CI 是 UTC），只断言形状不断言具体时分。
    expect(screen.getAllByTestId('tool-step-receipt-meta').map((node) => node.textContent)).toEqual([
      expect.stringMatching(/^成功 · 腾讯会议 · \d{2}:\d{2}$/),
      expect.stringMatching(/^失败 · 腾讯会议 · \d{2}:\d{2}$/),
    ]);
    expect(container.querySelector('[data-testid="tool-step-receipt-meta"]')?.className).toContain('truncate');
    expect(container.querySelector('.opacity-0')).toBeNull();

    fireEvent.click(screen.getAllByTestId('tool-call-row-tmeetMeetingList')[0]!);
    expect(screen.getByTestId('tool-step-receipt-detail').textContent).toContain('"scope":"upcoming"');
  });

  it('事件回放只让步骤行从进行中前进到终态，收口与持久化回填全程不建独立回执块', () => {
    const { container, rerender } = render(<TurnCard turn={tmeetTurn('running')} />);
    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.queryAllByTestId('tool-step-receipt-meta')).toHaveLength(0);

    rerender(<TurnCard turn={tmeetTurn('completed')} />);
    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    expect(screen.getAllByTestId('tool-step-receipt-meta')).toHaveLength(2);
    expect(container.querySelectorAll('.text-\\[var\\(--cc-success\\)\\]')).toHaveLength(1);

    // 持久化列表接管前的短窗口：turn 再标 streaming、result/receipt 暂缺。
    // 同一 call 已到过终态，步骤行仍保留终态和回执元信息，不能闪回进行中。
    rerender(<TurnCard turn={tmeetTurn('persistence-gap')} />);
    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    expect(screen.getAllByTestId('tool-step-receipt-meta')).toHaveLength(2);
    expect(container.querySelectorAll('.text-\\[var\\(--cc-success\\)\\]')).toHaveLength(1);

    rerender(<TurnCard turn={tmeetTurn('persisted')} />);
    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    expect(screen.getAllByTestId('tool-step-receipt-meta')).toHaveLength(2);
  });

  it('没有对应步骤组的回执仍保留为操作记录，失败标红，详情按需展开', () => {
    const { container } = render(<TraceNodeRenderer node={receiptNode()} />);

    expect(screen.getByTestId('turn-receipts-list')).toBeTruthy();
    expect(container.textContent).toContain('操作记录');
    expect(container.textContent).not.toContain('已执行');
    expect(container.textContent).toContain('发给 zhang@example.com 等 3 人');
    expect(container.textContent).toContain('创建日历事件失败：评审会');
    expect(container.textContent).toContain('邮件');
    expect(container.textContent).toContain('日历');
    expect(container.textContent).toContain('提醒事项');
    expect(container.textContent).not.toContain('mail_send');
    expect(container.textContent).not.toContain('calendar_create_event');
    expect(container.textContent).not.toContain('reminders_create');
    expect(container.textContent).not.toContain('li@example.com');
    expect(container.querySelector('.text-badge-danger')?.textContent).toBe('失败');

    const successSummary = screen.getByText('已发送邮件：周报 · 发给 zhang@example.com 等 3 人');
    fireEvent.click(successSummary.closest('button')!);
    expect(container.textContent).toContain('li@example.com');
    expect(container.textContent).toContain('wang@example.com');
  });

  it('英文界面的无匹配回执使用 Activity，并翻译 connector 与多人收件人摘要', () => {
    useAppStore.setState({ language: 'en' });

    const { container } = render(<TraceNodeRenderer node={receiptNode()} />);

    expect(container.textContent).toContain('Activity');
    expect(container.textContent).not.toContain('Executed');
    expect(container.textContent).toContain('Mail');
    expect(container.textContent).toContain('Calendar');
    expect(container.textContent).toContain('Reminders');
    expect(container.textContent).toContain('Sent to zhang@example.com and others (3 recipients)');
    expect(container.textContent).not.toContain('发给');
  });
});
