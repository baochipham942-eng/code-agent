// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
