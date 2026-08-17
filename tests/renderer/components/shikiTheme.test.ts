// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getShikiThemeForDataTheme,
  useShikiTheme,
} from '../../../src/renderer/components/features/chat/MessageBubble/shikiTheme';

describe('getShikiThemeForDataTheme', () => {
  it('dark / 未知 / 缺省回退 one-dark-pro', () => {
    expect(getShikiThemeForDataTheme('dark')).toBe('one-dark-pro');
    expect(getShikiThemeForDataTheme(null)).toBe('one-dark-pro');
    expect(getShikiThemeForDataTheme('something-else')).toBe('one-dark-pro');
  });

  it('亮色和两套高对比主题映射到对应 Shiki 主题', () => {
    expect(getShikiThemeForDataTheme('light')).toBe('one-light');
    expect(getShikiThemeForDataTheme('high-contrast-dark')).toBe('github-dark-high-contrast');
    expect(getShikiThemeForDataTheme('high-contrast-light')).toBe('github-light-high-contrast');
  });
});

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
  });
});
