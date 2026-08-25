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

function receiptTurn(status: TraceTurn['status']): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-receipts',
    nodes: [receiptNode()],
    status,
    startTime: 1_700_000_000_000,
    endTime: status === 'streaming' ? undefined : 1_700_000_001_000,
  };
}

describe('聊天流「已执行」区', () => {
  beforeEach(() => useAppStore.setState({ language: 'zh' }));
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });

  it('本轮流式中隐藏尾块，完成后才展开回执', () => {
    const { container, rerender } = render(<TurnCard turn={receiptTurn('streaming')} />);

    expect(screen.queryByTestId('turn-receipts-toggle')).toBeNull();
    expect(screen.queryByTestId('turn-receipts-list')).toBeNull();
    expect(container.textContent).not.toContain('已执行');

    rerender(<TurnCard turn={receiptTurn('completed')} />);

    expect(screen.getByTestId('turn-receipts-toggle')).toBeTruthy();
    expect(screen.getByTestId('turn-receipts-list')).toBeTruthy();
    expect(container.textContent).toContain('已执行');
  });

  it('默认展开成功与失败回执，失败标红，全部收件人点开后才出现', () => {
    const { container } = render(<TraceNodeRenderer node={receiptNode()} />);

    expect(screen.getByTestId('turn-receipts-list')).toBeTruthy();
    expect(container.textContent).toContain('已执行');
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

  it('英文界面同时翻译 connector 与多人收件人摘要', () => {
    useAppStore.setState({ language: 'en' });

    const { container } = render(<TraceNodeRenderer node={receiptNode()} />);

    expect(container.textContent).toContain('Mail');
    expect(container.textContent).toContain('Calendar');
    expect(container.textContent).toContain('Reminders');
    expect(container.textContent).toContain('Sent to zhang@example.com and others (3 recipients)');
    expect(container.textContent).not.toContain('发给');
  });
});
