// ============================================================================
// useAppshots — 监听 Rust 端 appshots 事件，写入 appshotsStore
// 在 App 顶层挂载一次即可（事件是全局的，状态在 store）。
//
// 事件契约（motion v2，详设 §5.2）：
//   capture_starting → image_ready（图先就绪，chip 进 reserved）→ handoff（显形）
//   → text_ready（AX/OCR 补齐）。capture_ready 全量事件 Rust 仍发（兼容），这里不再订阅。
// ============================================================================

import { useEffect } from 'react';
import type { AppshotCapture, AppshotImageReady, AppshotTextReady } from '@shared/contract/appshot';
import { useAppshotsStore } from '../stores/appshotsStore';
import { useSessionStore } from '../stores/sessionStore';
import { isNativeCommandRuntimeAvailable, invokeNativeCommandAction } from '../services/nativeCommandFacade';
import { listenTauriEvent } from '../services/tauriPluginFacade';
import { toast } from './useToast';

export function useAppshots(): void {
  const setStarting = useAppshotsStore((s) => s.setStarting);
  const setImageReady = useAppshotsStore((s) => s.setImageReady);
  const markHandoff = useAppshotsStore((s) => s.markHandoff);
  const patchText = useAppshotsStore((s) => s.patchText);
  const patchImage = useAppshotsStore((s) => s.patchImage);

  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable()) {
      return; // 非 Tauri（dev:web）环境无 appshots
    }
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      try {
        const offStarting = await listenTauriEvent<{ requestId: string }>('appshots:capture_starting', () => {
          setStarting(true, useSessionStore.getState().currentSessionId);
        });
        const offImageReady = await listenTauriEvent<AppshotImageReady>('appshots:image_ready', (event) => {
          const ready = event.payload;
          if (!ready?.requestId) return;
          void (async () => {
            // 图先就绪：与飞入并行读取 dataURL，到了就 patch 进 chip（不等文本）。
            if (!ready.screenshotDataUrl) {
              void invokeNativeCommandAction('readAppshotImageDataUrl', { path: ready.screenshotPath })
                .then((dataUrl) => patchImage(ready.requestId, dataUrl))
                .catch((error) => console.error('[appshot] 读取截图 dataURL 失败', error));
            }
            const capture: AppshotCapture = {
              requestId: ready.requestId,
              appName: ready.appName,
              bundleId: ready.bundleId,
              windowTitle: ready.windowTitle,
              screenshotPath: ready.screenshotPath,
              screenshotDataUrl: ready.screenshotDataUrl,
              axText: null,
              textSource: 'none',
              windowFrame: ready.windowFrame,
              capturedAtMs: ready.capturedAtMs,
            };
            // 发送目标设置：'new' 时先开新会话再绑定，'current' 沿用捕获发起时的会话（防串台）。
            // 由 Rust 捕获时直读 config.json 带入事件载荷（前端不在捕获链路走设置 IPC）；
            // 缺省回落 store 缓存（设置页变更时写入）。
            const targetSession = ready.targetSession ?? useAppshotsStore.getState().targetSession;
            let sessionId: string | null;
            if (targetSession === 'new') {
              const created = await useSessionStore.getState().createSession();
              sessionId = created?.id ?? useSessionStore.getState().currentSessionId;
            } else {
              sessionId =
                useAppshotsStore.getState().startingSessionId
                ?? useSessionStore.getState().currentSessionId;
            }
            setImageReady(capture, sessionId);
          })();
        });
        const offHandoff = await listenTauriEvent<{ requestId: string }>('appshots:handoff', (event) => {
          const requestId = event.payload?.requestId;
          if (requestId) markHandoff(requestId);
        });
        const offTextReady = await listenTauriEvent<AppshotTextReady>('appshots:text_ready', (event) => {
          const ready = event.payload;
          if (ready?.requestId) {
            patchText(ready.requestId, ready.axText ?? null, ready.textSource ?? 'none');
          }
        });
        const offError = await listenTauriEvent<{ code?: string; message?: string }>('appshots:error', (event) => {
          setStarting(false, null);
          const msg = event.payload?.message ?? event.payload?.code ?? '未知错误';
          toast.error(`Appshot 失败：${msg}`);
        });
        cleanup = () => {
          offStarting();
          offImageReady();
          offHandoff();
          offTextReady();
          offError();
        };
      } catch {
        cleanup = () => {};
      }
    };

    void setup();
    return () => cleanup?.();
  }, [setStarting, setImageReady, markHandoff, patchText, patchImage]);
}
