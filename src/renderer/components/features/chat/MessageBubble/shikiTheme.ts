import { useSyncExternalStore } from 'react';

export type ShikiThemeName =
  | 'one-dark-pro'
  | 'one-light'
  | 'github-dark-high-contrast'
  | 'github-light-high-contrast';

const DATA_THEME_FALLBACK = 'dark';

function getShikiThemeForDataTheme(theme: string | null): ShikiThemeName {
  switch (theme) {
    case 'light':
      return 'one-light';
    case 'high-contrast-dark':
      return 'github-dark-high-contrast';
    case 'high-contrast-light':
      return 'github-light-high-contrast';
    default:
      return 'one-dark-pro';
  }
}

function subscribeDataTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getDataTheme(): string {
  return document.documentElement.getAttribute('data-theme') ?? DATA_THEME_FALLBACK;
}

export function useShikiTheme(): ShikiThemeName {
  const theme = useSyncExternalStore(subscribeDataTheme, getDataTheme, () => DATA_THEME_FALLBACK);
  return getShikiThemeForDataTheme(theme);
}
