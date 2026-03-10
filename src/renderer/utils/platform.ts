/**
 * Platform detection utilities for Web/Electron/Tauri mode UI degradation.
 *
 * Web mode is determined by the Vite build target injected in vite.web.config.ts:
 *   'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web')
 *
 * Tauri mode is detected by checking for the __TAURI_INTERNALS__ global that
 * Tauri 2.x injects into the webview at runtime.
 *
 * This is more reliable than checking window.electronAPI because the Web build
 * injects an HTTP polyfill for electronAPI.
 */

export function isTauriMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

export function isWebMode(): boolean {
  return import.meta.env.VITE_BUILD_TARGET === 'web';
}

export function isElectronMode(): boolean {
  return !isWebMode() && !isTauriMode();
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
