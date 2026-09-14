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

  it('启动失败重发布的卡显示失败原因且仍可批准（同一记录重试）', () => {
    const failedPreview = JSON.stringify({
      plan: '1. Read host',
      failureReason: 'Session s1 is already running',
    });
    const respond = vi.fn(async () => {});
    render(<PlanCard card={{ preview: failedPreview, status: 'pending' }} text={text} disabled={false} respond={respond} />);
    expect(screen.getByRole('alert').textContent).toContain('Session s1 is already running');
    fireEvent.click(screen.getByText(text.planApprove));
    expect(respond).toHaveBeenCalledWith('approved', undefined);
  });

  it('settled cards show the elsewhere-handled state', () => {
    render(<PlanCard card={{ preview, status: 'rejected' }} text={text} disabled={false} respond={async () => {}} />);
    expect(screen.getByText(text.planClosed)).toBeTruthy();
    expect(screen.queryByText(text.planApprove)).toBeNull();
  });

  it('english copy is present for the same keys', () => {
    const en = messages('en');
    render(<PlanCard card={{ preview, status: 'closed' }} text={en} disabled={false} respond={async () => {}} />);
    expect(screen.getByText(en.planClosed)).toBeTruthy();
  });
});
