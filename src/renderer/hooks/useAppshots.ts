// ============================================================================
// useAppshots — 监听 Rust 端 appshots 事件，写入 appshotsStore
// 在 App 顶层挂载一次即可（事件是全局的，状态在 store）。
// ============================================================================

import { useEffect } from 'react';
import type { AppshotCapture } from '@shared/contract/appshot';
import { useAppshotsStore } from '../stores/appshotsStore';
import { useSessionStore } from '../stores/sessionStore';
import { toast } from './useToast';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R> } }).__TAURI_INTERNALS__;
  if (!internals) throw new Error('Tauri runtime not available');
  return internals.invoke<T>(cmd, args);
}

export function useAppshots(): void {
  const setPending = useAppshotsStore((s) => s.setPending);
  const setStarting = useAppshotsStore((s) => s.setStarting);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      return; // 非 Tauri（dev:web）环境无 appshots
    }
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const offStarting = await listen('appshots:capture_starting', () => {
          setStarting(true, useSessionStore.getState().currentSessionId);
        });
        const offReady = await listen<AppshotCapture>('appshots:capture_ready', async (event) => {
          const capture = { ...event.payload };
          const sessionId =
            useAppshotsStore.getState().startingSessionId
            ?? useSessionStore.getState().currentSessionId;
          // 事件只带磁盘路径；按需读取 base64 dataURL 作为图片附件数据。
          try {
            capture.screenshotDataUrl = await invoke<string>('appshots_read_image_data_url', {
              path: capture.screenshotPath,
            });
          } catch (error) {
            console.error('[appshot] 读取截图 dataURL 失败', error);
          }
          setPending(capture, sessionId);
        });
        const offError = await listen<{ code?: string; message?: string }>('appshots:error', (event) => {
          setStarting(false, null);
          const msg = event.payload?.message ?? event.payload?.code ?? '未知错误';
          toast.error(`Appshot 失败：${msg}`);
        });
        cleanup = () => {
          offStarting();
          offReady();
          offError();
        };
      } catch {
        cleanup = () => {};
      }
    };

    void setup();
    return () => cleanup?.();
  }, [setPending, setStarting]);
}
