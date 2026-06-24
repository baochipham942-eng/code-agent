/**
 * Platform detection utilities for Web/native desktop mode UI degradation.
 *
 * Web mode is determined by the Vite build target injected in vite.web.config.ts:
 *   'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web')
 *
 * Tauri mode is detected by checking for the __TAURI_INTERNALS__ global that
 * Tauri 2.x injects into the webview at runtime.
 *
 * This is more reliable than checking bridge globals because the Web/Tauri build
 * injects HTTP polyfills for compatibility APIs.
 */

import { openNativePath, openNativeUrl } from '../services/tauriPluginFacade';

export function isTauriMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

export function isWebMode(): boolean {
  return import.meta.env.VITE_BUILD_TARGET === 'web';
}

function isLegacyElectronMode(): boolean {
  return !isWebMode() && !isTauriMode();
}

export function isDesktopShellMode(): boolean {
  return isLegacyElectronMode() || isTauriMode();
}

export function getDesktopShellLabel(): string {
  if (isTauriMode()) return 'Tauri 桌面版';
  if (isLegacyElectronMode()) return '桌面版';
  return 'Web';
}

/**
 * 在聊天等富文本里打开链接。桌面(Tauri)下拦截点击并用系统能力打开
 * （http(s) 外链 → 默认浏览器；本地文件/路径 → 默认应用，HTML 即浏览器）；
 * web 模式返回 false，让原生 <a target="_blank"> 接管，不破坏浏览器内行为。
 * 返回 true 表示已接管，调用方应 e.preventDefault()。
 */
export function openExternalLink(href: string | undefined): boolean {
  if (!href || !isTauriMode()) return false;
  const isHttp = /^https?:\/\//i.test(href);
  void (isHttp ? openNativeUrl(href) : openNativePath(href.replace(/^file:\/\//, '')))
    .catch(() => {});
  return true;
}

/** Copy text to clipboard with fallback */
export async function copyPathToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  }
}
