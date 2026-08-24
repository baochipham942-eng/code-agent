// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import type { TraceNode } from '../../../src/shared/contract/trace';

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
            summary: '已发送邮件：周报 · 发给 zhang@example.com 等 3 人',
            detail: 'To: zhang@example.com, li@example.com, wang@example.com',
            sourceTool: 'mail_send',
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
          },
        },
      ],
    },
  };
}

describe('聊天流「已执行」区', () => {
  afterEach(() => cleanup());

  it('默认展开成功与失败回执，失败标红，全部收件人点开后才出现', () => {
    const { container } = render(<TraceNodeRenderer node={receiptNode()} />);

    expect(screen.getByTestId('turn-receipts-list')).toBeTruthy();
    expect(container.textContent).toContain('已执行');
    expect(container.textContent).toContain('发给 zhang@example.com 等 3 人');
    expect(container.textContent).toContain('创建日历事件失败：评审会');
    expect(container.textContent).not.toContain('li@example.com');
    expect(container.querySelector('.text-badge-danger')?.textContent).toBe('失败');

    const successSummary = screen.getByText('已发送邮件：周报 · 发给 zhang@example.com 等 3 人');
    fireEvent.click(successSummary.closest('button')!);
    expect(container.textContent).toContain('li@example.com');
    expect(container.textContent).toContain('wang@example.com');
  });
});
