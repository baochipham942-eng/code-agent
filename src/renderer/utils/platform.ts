/**
 * Platform detection utilities for Web/Electron mode UI degradation.
 *
 * Web mode is determined by the Vite build target injected in vite.web.config.ts:
 *   'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web')
 *
 * This is more reliable than checking window.electronAPI because the Web build
 * injects an HTTP polyfill for electronAPI.
 */

export function isWebMode(): boolean {
  return import.meta.env.VITE_BUILD_TARGET === 'web';
}

export function isElectronMode(): boolean {
  return !isWebMode();
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
