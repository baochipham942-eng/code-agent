// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotaWaitNotice } from '../../../src/renderer/components/features/chat/quotaWaitNotice';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('QuotaWaitNotice', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the clock while the wait is ahead, and the due-passed line after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 15, 0, 0));
    const onCancel = vi.fn();
    const onRetryNow = vi.fn();
    useAppStore.setState({ language: 'zh' });
    const dueAt = new Date(2026, 9, 27, 16, 40, 0).getTime();
    const { rerender } = render(
      <QuotaWaitNotice dueAt={dueAt} duePassed={false} onCancel={onCancel} onRetryNow={onRetryNow} />,
    );
    expect(screen.getByTestId('quota-wait-notice').textContent).toContain('额度限流，预计 16:40 继续');
    fireEvent.click(screen.getByTestId('quota-wait-cancel'));
    fireEvent.click(screen.getByTestId('quota-wait-retry'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRetryNow).toHaveBeenCalledTimes(1);

    const tomorrow = new Date(2026, 9, 28, 9, 5, 0).getTime();
    rerender(<QuotaWaitNotice dueAt={tomorrow} duePassed={false} onCancel={onCancel} onRetryNow={onRetryNow} />);
    expect(screen.getByTestId('quota-wait-notice').textContent).toContain('额度限流，预计 2026-10-28 09:05 继续');

    rerender(<QuotaWaitNotice dueAt={dueAt} duePassed onCancel={onCancel} onRetryNow={onRetryNow} />);
    expect(screen.getByTestId('quota-wait-notice').textContent).toContain('已到点，点继续');
    expect(screen.getByTestId('quota-wait-retry').textContent).toBe('现在重试');

    useAppStore.setState({ language: 'en' });
    rerender(<QuotaWaitNotice dueAt={dueAt} duePassed={false} onCancel={onCancel} onRetryNow={onRetryNow} />);
    expect(screen.getByTestId('quota-wait-notice').textContent).toContain('Quota limit reached. Continuing at 16:40');
    rerender(<QuotaWaitNotice dueAt={dueAt} duePassed onCancel={onCancel} onRetryNow={onRetryNow} />);
    expect(screen.getByTestId('quota-wait-notice').textContent).toContain('The wait is over. Continue to resume');
    expect(screen.getByTestId('quota-wait-retry').textContent).toBe('Retry now');
  });
});
