/**
 * Type declarations for Tauri 2.x globals injected into the webview.
 */

interface TauriInvokeOptions {
  headers?: Record<string, string>;
}

interface TauriCore {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: TauriInvokeOptions): Promise<T>;
}

interface TauriInternals {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>, options?: TauriInvokeOptions): Promise<T>;
  metadata: {
    currentWebview: { windowLabel: string; label: string };
    currentWindow: { label: string };
  };
}

interface Window {
  __TAURI__?: {
    core: TauriCore;
    [key: string]: unknown;
  };
  __TAURI_INTERNALS__?: TauriInternals;
}
