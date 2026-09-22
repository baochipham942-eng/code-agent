// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { toast, useToastStore } from '../../../src/renderer/hooks/useToast';

describe('ToastContainer renders toast.show', () => {
  afterEach(() => {
    cleanup();
    useToastStore.setState({ toasts: [] });
  });

  it('shows the export-markdown copy that used to die in uiStore', () => {
    render(<ToastContainer />);
    act(() => {
      toast.show('success', 'Markdown 已导出', 60_000);
    });
    expect(screen.getByText('Markdown 已导出')).toBeTruthy();
  });

  it('keeps a duration=0 toast and returns its id', () => {
    vi.useFakeTimers();
    try {
      render(<ToastContainer />);
      let id = '';
      act(() => {
        id = toast.show('info', '需要手动关闭', 0);
      });
      expect(id).toMatch(/^toast-/);
      expect(screen.getByText('需要手动关闭')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('需要手动关闭')).toBeTruthy();
      expect(useToastStore.getState().toasts.map((item) => item.id)).toContain(id);
    } finally {
      vi.useRealTimers();
    }
  });
});
