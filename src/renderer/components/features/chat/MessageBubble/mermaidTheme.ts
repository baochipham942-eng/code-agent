import { useSyncExternalStore } from 'react';

// 与同目录 shikiTheme.ts 同形：mermaid 是第三方库，只吃字面色、读不到 app 的 CSS 变量，
// 所以主题必须在 JS 侧按 data-theme 显式派发，而不能靠样式继承。
export type MermaidThemeName = 'dark' | 'light';

const DATA_THEME_FALLBACK = 'dark';

function getMermaidThemeForDataTheme(theme: string | null): MermaidThemeName {
  return theme === 'light' || theme === 'high-contrast-light' ? 'light' : 'dark';
}

function subscribeDataTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getDataTheme(): string {
  return document.documentElement.getAttribute('data-theme') ?? DATA_THEME_FALLBACK;
}

export function useMermaidTheme(): MermaidThemeName {
  const theme = useSyncExternalStore(subscribeDataTheme, getDataTheme, () => DATA_THEME_FALLBACK);
  return getMermaidThemeForDataTheme(theme);
}
