import { hasNativeBridge } from '../api/transport';

function getBrowserAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

export function resolveFileUrl(filePath: string): string {
  if (!filePath) return '';

  if (
    filePath.startsWith('data:') ||
    filePath.startsWith('http://') ||
    filePath.startsWith('https://') ||
    filePath.startsWith('file://')
  ) {
    return filePath;
  }

  const isWebMode = typeof window !== 'undefined'
    && (!hasNativeBridge() || window.location.protocol === 'http:' || window.location.protocol === 'https:');

  if (isWebMode) {
    if (filePath.includes('/.code-agent/appshots/')) {
      const params = new URLSearchParams({ path: filePath });
      return `/api/screenshot?${params.toString()}`;
    }

    const params = new URLSearchParams({ path: filePath });
    const token = getBrowserAuthToken();
    if (token) params.set('token', token);
    return `/api/workspace/file?${params.toString()}`;
  }

  return `file://${filePath}`;
}
