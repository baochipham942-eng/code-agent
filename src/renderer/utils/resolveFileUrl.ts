import { hasNativeBridge } from '../api/transport';

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
    return `/api/workspace/file?path=${encodeURIComponent(filePath)}`;
  }

  return `file://${filePath}`;
}
