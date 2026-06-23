// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useTheme 的 renderHook 测试 —— 同时作为「renderer hook 测试基建」的首个验证：
// 用 per-file `@vitest-environment jsdom` pragma 选择性开 DOM 环境（不动全局
// environment:node，保护其余 1000+ node 测试），@testing-library/react 的
// renderHook + act 驱动 hook。jsdom 不实现 window.matchMedia，需自行 stub。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from '../../../src/renderer/hooks/useTheme';

// 可控的 matchMedia stub：记录 change 监听器，便于测试触发系统主题变化。
let matchMediaListeners: Array<(e: { matches: boolean }) => void>;
let systemPrefersDark: boolean;

function installMatchMedia() {
  matchMediaListeners = [];
  systemPrefersDark = true;
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return systemPrefersDark;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => matchMediaListeners.push(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
      matchMediaListeners = matchMediaListeners.filter((l) => l !== cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as never;
}

function fireSystemThemeChange(matches: boolean) {
  systemPrefersDark = matches;
  act(() => {
    matchMediaListeners.forEach((cb) => cb({ matches }));
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
  installMatchMedia();
  // rAF 在 jsdom 存在，但用同步 stub 避免悬挂回调
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTheme 初始状态', () => {
  it('无存储时默认 dark，并把 dark class / data-theme 应用到 documentElement', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('读取已存储的 light 偏好', () => {
    localStorage.setItem('code-agent-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it("theme=system 时按系统偏好解析", () => {
    localStorage.setItem('code-agent-theme', 'system');
    systemPrefersDark = false;
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
  });
});

describe('setTheme / toggleTheme', () => {
  it('setTheme 持久化到 localStorage 并更新 DOM', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('light'));
    expect(localStorage.getItem('code-agent-theme')).toBe('light');
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('toggleTheme 在 dark/light 间切换（忽略 system）', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe('dark');
    act(() => result.current.toggleTheme());
    expect(result.current.resolvedTheme).toBe('light');
    act(() => result.current.toggleTheme());
    expect(result.current.resolvedTheme).toBe('dark');
  });
});

describe('系统主题变化监听', () => {
  it('theme=system 时跟随系统 change 事件更新 resolvedTheme', () => {
    localStorage.setItem('code-agent-theme', 'system');
    const { result } = renderHook(() => useTheme());
    fireSystemThemeChange(false);
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    fireSystemThemeChange(true);
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('theme 非 system 时忽略系统 change 事件', () => {
    localStorage.setItem('code-agent-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    fireSystemThemeChange(false);
    expect(result.current.resolvedTheme).toBe('dark'); // 不受系统影响
  });

  it('卸载时移除 change 监听器', () => {
    const { unmount } = renderHook(() => useTheme());
    expect(matchMediaListeners.length).toBeGreaterThan(0);
    unmount();
    expect(matchMediaListeners.length).toBe(0);
  });
});
