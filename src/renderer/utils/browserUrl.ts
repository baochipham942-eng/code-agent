const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const DEFAULT_BROWSER_SCHEME = 'https://';

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return URL_SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `${DEFAULT_BROWSER_SCHEME}${trimmed}`;
}
