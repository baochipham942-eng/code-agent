// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionCard } from '../../../packages/mobile/src/features/sessions/QuestionCard';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const preview = JSON.stringify({
  questions: [{
    question: '这份提案主要给谁看？',
    header: '读者',
    options: [
      { label: '内部产品团队' },
      { label: '品牌与市场团队' },
      { label: '客户或合作伙伴' },
    ],
  }],
});

describe('QuestionCard', () => {
  afterEach(cleanup);

  it('renders options and submits the selected answer', async () => {
    const respond = vi.fn(async () => {});
    render(<QuestionCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} skip={async () => {}} />);
    expect(screen.getByText('这份提案主要给谁看？')).toBeTruthy();
    fireEvent.click(screen.getByText('品牌与市场团队'));
    fireEvent.click(screen.getByText(text.questionSubmit));
    expect(respond).toHaveBeenCalledWith({ 读者: '品牌与市场团队' });
  });

  it('accepts a free-text answer in the other field', async () => {
    const respond = vi.fn(async () => {});
    render(<QuestionCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} skip={async () => {}} />);
    fireEvent.change(screen.getByPlaceholderText(text.questionOtherPlaceholder), { target: { value: '换个方案' } });
    fireEvent.click(screen.getByText(text.questionSubmit));
    expect(respond).toHaveBeenCalledWith({ 读者: '换个方案' });
  });

  it('answered cards highlight the chosen option, fade the rest, and hide the input', () => {
    render(<QuestionCard
      card={{ preview, status: 'approved', outcome: 'answered', answer: { answers: { 读者: '品牌与市场团队' } } }}
      text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText('品牌与市场团队').closest('button')?.dataset.selected).toBe('true');
    expect(screen.getByTestId('question-choice-check').textContent).toBe('✓');
    expect(screen.getByText('内部产品团队').closest('button')?.dataset.faded).toBe('true');
    expect(screen.queryByPlaceholderText(text.questionOtherPlaceholder)).toBeNull();
    expect(screen.queryByText(text.questionSubmit)).toBeNull();
    expect(screen.queryByText(/另一端/)).toBeNull();
  });

  it('free-text answers render as 你的回答', () => {
    render(<QuestionCard
      card={{ preview, status: 'approved', outcome: 'answered', answer: { answers: { 读者: '经销商伙伴' } } }}
      text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByTestId('question-your-answer').textContent).toBe(`${text.questionYourAnswer}经销商伙伴`);
  });

  it('expired and cancelled cards fade every option and say the real reason', () => {
    const { rerender } = render(<QuestionCard card={{ preview, status: 'closed', outcome: 'expired' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByTestId('question-outcome').textContent).toBe('已超时，Neo 没用上这个问题');
    expect(screen.getByText('品牌与市场团队').closest('button')?.dataset.faded).toBe('true');
    rerender(<QuestionCard card={{ preview, status: 'closed', outcome: 'cancelled' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByTestId('question-outcome').textContent).toBe('任务已停止，这张卡作废了');
    expect(screen.queryByText(/另一端/)).toBeNull();
  });

  it('english copy is present for the same keys', () => {
    const en = messages('en');
    render(<QuestionCard card={{ preview, status: 'closed', outcome: 'expired' }} text={en} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText(en.questionExpired)).toBeTruthy();
  });

  it('closed cards without outcome say 这张卡已结束 and do not mark a choice', () => {
    render(<QuestionCard card={{ preview, status: 'closed' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByTestId('question-outcome').textContent).toBe('这张卡已结束');
    expect(screen.queryByText('任务已停止，这张卡作废了')).toBeNull();
    expect(screen.queryByTestId('question-choice-check')).toBeNull();
    expect(text.questionClosed).toBe(text.approvalClosed);
    expect(text.questionClosed).toBe(text.planClosed);
    expect(messages('en').questionClosed).toBe('This card has ended.');
  });
});
