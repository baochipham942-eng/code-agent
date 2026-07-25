import { hasNativeBridge } from '../api/transport';
import { CONFIG_DIR_NEW } from '../../shared/constants/configDir';

function getBrowserAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

/** /api/screenshot 已收进鉴权（回的是用户屏幕真实画面），URL 必须带 query token（同 SSE 路径）。 */
export function resolveScreenshotUrl(filePath: string): string {
  const params = new URLSearchParams({ path: filePath });
  const token = getBrowserAuthToken();
  if (token) params.set('token', token);
  return `/api/screenshot?${params.toString()}`;
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
    // app 私有配置目录（.code-agent）下的图片走专用截图路由，由后端按运行时真实目录做白名单校验。
    // normalize 分隔符以兼容 Windows 反斜杠路径。
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes(`/${CONFIG_DIR_NEW}/`)) {
      return resolveScreenshotUrl(filePath);
    }

    const params = new URLSearchParams({ path: filePath });
    const token = getBrowserAuthToken();
    if (token) params.set('token', token);
    return `/api/workspace/file?${params.toString()}`;
  }

  return `file://${filePath}`;
}
