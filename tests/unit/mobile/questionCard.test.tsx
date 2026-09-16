// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionCard } from '../../../packages/mobile/src/features/sessions/QuestionCard';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const preview = JSON.stringify({
  questions: [{
    question: '下一步怎么走？',
    header: '方向',
    options: [
      { label: '继续', description: '按原计划', recommended: true },
      { label: '停止', description: '先停下' },
    ],
  }],
});

describe('QuestionCard', () => {
  afterEach(cleanup);

  it('renders options and submits the selected answer', async () => {
    const respond = vi.fn(async () => {});
    render(<QuestionCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} skip={async () => {}} />);
    expect(screen.getByText('下一步怎么走？')).toBeTruthy();
    expect(screen.getByText(text.questionRecommended)).toBeTruthy();
    fireEvent.click(screen.getByText('继续'));
    fireEvent.click(screen.getByText(text.questionSubmit));
    expect(respond).toHaveBeenCalledWith({ 方向: '继续' });
  });

  it('accepts a free-text answer in the other field', async () => {
    const respond = vi.fn(async () => {});
    render(<QuestionCard card={{ preview, status: 'pending' }} text={text} disabled={false} respond={respond} skip={async () => {}} />);
    fireEvent.change(screen.getByPlaceholderText(text.questionOtherPlaceholder), { target: { value: '换个方案' } });
    fireEvent.click(screen.getByText(text.questionSubmit));
    expect(respond).toHaveBeenCalledWith({ 方向: '换个方案' });
  });

  // 爸 2026-09-16 真机：在手机上答完/允许完，卡片却说「已在另一端…或已失效」，像是失败了。结果按状态如实说
  it('settled cards lose their actions and say what actually happened', () => {
    const { rerender } = render(<QuestionCard card={{ preview, status: 'approved' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText(text.questionAnswered)).toBeTruthy();
    expect(screen.queryByText(text.questionSubmit)).toBeNull();
    rerender(<QuestionCard card={{ preview, status: 'rejected' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText(text.questionSkipped)).toBeTruthy();
    rerender(<QuestionCard card={{ preview, status: 'closed' }} text={text} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText(text.questionClosed)).toBeTruthy();
  });

  it('english copy is present for the same keys', () => {
    const en = messages('en');
    render(<QuestionCard card={{ preview, status: 'closed' }} text={en} disabled={false} respond={async () => {}} skip={async () => {}} />);
    expect(screen.getByText(en.questionClosed)).toBeTruthy();
  });
});
