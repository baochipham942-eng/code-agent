// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useShikiTheme } from '../../../src/renderer/components/features/chat/MessageBubble/shikiTheme';

describe('useShikiTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('订阅 html data-theme 并跟随切换', async () => {
    const { result } = renderHook(() => useShikiTheme());
    expect(result.current).toBe('one-dark-pro');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    expect(result.current).toBe('one-light');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'high-contrast-dark');
    });
    expect(result.current).toBe('github-dark-high-contrast');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'high-contrast-light');
    });
    expect(result.current).toBe('github-light-high-contrast');
  });
});
