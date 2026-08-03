// ============================================================================
// useTheme - Theme Management Hook
// ============================================================================

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system' | 'high-contrast-light' | 'high-contrast-dark';
export type ResolvedTheme = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';

/** 除 'system' 外的全部可选主题值（system 只是档位，不是可应用的主题） */
const EXPLICIT_THEMES: readonly ResolvedTheme[] = [
  'light',
  'dark',
  'high-contrast-light',
  'high-contrast-dark',
];

interface UseThemeReturn {
  /** Current theme setting (light, dark, system, or a high-contrast variant) */
  theme: Theme;
  /** Resolved theme based on system preference if theme is 'system' */
  resolvedTheme: ResolvedTheme;
  /** Set the theme */
  setTheme: (theme: Theme) => void;
  /** Toggle between light and dark (ignores system) */
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = 'code-agent-theme';

/**
 * Get system color scheme preference
 */
function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Get stored theme preference
 */
function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'system' || (EXPLICIT_THEMES as readonly string[]).includes(stored ?? '')) {
    return stored as Theme;
  }
  return 'dark'; // Default to dark（未知/旧值一律回退，不炸）
}

/**
 * Apply theme to document
 */
function applyTheme(resolvedTheme: ResolvedTheme): void {
  const root = document.documentElement;

  // Add class to prevent transition flash
  document.body.classList.add('theme-switching');

  // Update data-theme attribute
  root.setAttribute('data-theme', resolvedTheme);

  // Update classes：Tailwind 的 dark: 变体由 tailwind.config.js 的 darkMode 选择器
  // 按 data-theme 判定，与这里的 class 无关。这里挂 dark/light 基类是为了命中
  // themes/dark.css / light.css 里的 .dark / .light token 块（hc 主题在其上覆盖），
  // 高对比主题额外挂同名 class，命中 .high-contrast-* 选择器（focus-visible 环、
  // ChatView 的 [.high-contrast-dark_&] 覆盖等只认 class 不认 data-theme 的规则）。
  root.classList.remove('light', 'dark', 'high-contrast-light', 'high-contrast-dark');
  root.classList.add(resolvedTheme);
  if (resolvedTheme === 'high-contrast-dark') {
    root.classList.add('dark');
  } else if (resolvedTheme === 'high-contrast-light') {
    root.classList.add('light');
  }

  // Remove transition blocker after a frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove('theme-switching');
    });
  });
}

/**
 * Theme management hook
 * Supports light, dark, system, and high-contrast themes with persistence.
 * 高对比只做显式选择：'system' 档只跟随 prefers-color-scheme（明暗），
 * 不跟随 prefers-contrast——见工单 2026-08-02-高对比主题入口 的决策记录。
 */
export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    const stored = getStoredTheme();
    return stored === 'system' ? getSystemTheme() : stored;
  });

  // Handle system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = (e: MediaQueryListEvent) => {
      if (theme === 'system') {
        const newTheme = e.matches ? 'dark' : 'light';
        setResolvedTheme(newTheme);
        applyTheme(newTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Apply theme on mount and when theme changes
  useEffect(() => {
    const resolved = theme === 'system' ? getSystemTheme() : theme;
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, [theme]);

  // Set theme with persistence
  const setTheme = useCallback((newTheme: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    setThemeState(newTheme);
  }, []);

  // Toggle between light and dark
  const toggleTheme = useCallback(() => {
    const newTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
  }, [resolvedTheme, setTheme]);

  return {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
  };
}

export default useTheme;
