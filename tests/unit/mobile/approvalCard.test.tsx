// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalCard } from '../../../packages/mobile/src/features/sessions/ApprovalCard';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const preview = JSON.stringify({
  type: 'file_write',
  details: { path: '/tmp/cover.png', newContent: 'img' },
});

describe('ApprovalCard', () => {
  afterEach(cleanup);

  it('pending cards keep allow/deny actions', () => {
    render(<ApprovalCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByText(text.approveOnce)).toBeTruthy();
    expect(screen.getByText(text.deny)).toBeTruthy();
  });

  it('answered cards replace buttons with the final result line', () => {
    const { rerender } = render(<ApprovalCard
      card={{ preview, status: 'approved', outcome: 'answered', answer: { decision: 'approved' } }}
      text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('approval-result').textContent).toContain('已允许');
    expect(screen.queryByText(text.approveOnce)).toBeNull();
    rerender(<ApprovalCard
      card={{ preview, status: 'rejected', outcome: 'answered', answer: { decision: 'rejected' } }}
      text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('approval-result').textContent).toContain('已拒绝');
    rerender(<ApprovalCard
      card={{ preview, status: 'approved', outcome: 'answered', answer: { decision: 'allow_session' } }}
      text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('approval-result').textContent).toBe(`✓ ${text.approvalAllowedSession}`);
    expect(screen.queryByText(/另一端/)).toBeNull();
  });

  it('expired and cancelled cards say the real reason', () => {
    const { rerender } = render(<ApprovalCard card={{ preview, status: 'closed', outcome: 'expired' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('approval-result').textContent).toBe('已超时，这次操作没有执行');
    rerender(<ApprovalCard card={{ preview, status: 'closed', outcome: 'cancelled' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('approval-result').textContent).toBe('任务已停止，这张卡作废了');
  });
});
