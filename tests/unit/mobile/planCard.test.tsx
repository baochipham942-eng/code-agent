// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanCard } from '../../../packages/mobile/src/features/sessions/PlanCard';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const preview = JSON.stringify({
  plan: '1. Read host\n2. Write the card',
  agentName: 'Coder',
  risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
});

describe('PlanCard', () => {
  afterEach(cleanup);

  it('renders the plan expanded and approves with optional feedback', async () => {
    const respond = vi.fn(async () => {});
    render(<PlanCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} />);
    expect(screen.getByText(/Write the card/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(text.planFeedbackPlaceholder), { target: { value: '先做最小闭环' } });
    fireEvent.click(screen.getByText(text.planApprove));
    expect(respond).toHaveBeenCalledWith('approved', '先做最小闭环');
  });

  it('rejects without leaving the card clickable after close', () => {
    const respond = vi.fn(async () => {});
    render(<PlanCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} />);
    fireEvent.click(screen.getByText(text.planReject));
    expect(respond).toHaveBeenCalledWith('rejected', undefined);
  });

  it('settled cards show 已批准 or 已要求修改 with the feedback', () => {
    const { rerender } = render(<PlanCard
      card={{ preview, status: 'approved', outcome: 'answered', answer: { decision: 'approved' } }}
      text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('plan-result').textContent).toBe('已批准');
    expect(screen.queryByText(text.planApprove)).toBeNull();
    rerender(<PlanCard
      card={{ preview, status: 'rejected', outcome: 'answered', answer: { decision: 'rejected', feedback: '先改标题' } }}
      text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('plan-result').textContent).toBe('已要求修改：先改标题');
    rerender(<PlanCard card={{ preview, status: 'closed', outcome: 'expired' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('plan-result').textContent).toBe('已超时，Neo 没用上这个问题');
    expect(screen.queryByText(/另一端/)).toBeNull();
  });

  it('english copy is present for the same keys', () => {
    const en = messages('en');
    render(<PlanCard card={{ preview, status: 'closed', outcome: 'cancelled' }} text={en} disabled={false} respond={async () => {}} />);
    expect(screen.getByText(en.questionCancelled)).toBeTruthy();
  });

  it('closed cards without outcome say 这张卡已结束 and do not mark ✓/✕', () => {
    render(<PlanCard card={{ preview, status: 'closed' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByTestId('plan-result').textContent).toBe('这张卡已结束');
    expect(screen.queryByText('任务已停止，这张卡作废了')).toBeNull();
    expect(screen.getByTestId('plan-result').textContent).not.toMatch(/[✓✕]/);
    expect(messages('en').planClosed).toBe('This card has ended.');
  });
});
