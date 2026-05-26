import { useEffect, useRef } from 'react';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';

// Tauri 命令调用：走 __TAURI_INTERNALS__（与 useAppshots 同款），区别于 ipcService.invoke
// （后者是 TS-main 的 IPC 通道）。pip_* 与 appshots_read_image_data_url 都是 Rust 端命令。
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke<R>(c: string, a?: Record<string, unknown>): Promise<R> };
    }
  ).__TAURI_INTERNALS__;
  if (!internals) throw new Error('Tauri runtime not available');
  return internals.invoke<T>(cmd, args);
}

// 从 tool_call_end 的 ToolResult 里取 computer-use 表面截图路径（不依赖工具名，
// 只认 metadata.computerSurfaceSnapshot.screenshotPath，对 computer-use observe/get_state 等都通用）。
function extractSurfaceScreenshotPath(data: unknown): string | undefined {
  const meta = (
    data as
      | { metadata?: { computerSurfaceSnapshot?: { screenshotPath?: string | null } } }
      | undefined
  )?.metadata;
  const path = meta?.computerSurfaceSnapshot?.screenshotPath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

const RUN_END_EVENTS = new Set<string>(['agent_complete', 'agent_cancelled', 'stream_end', 'error']);

/**
 * Computer-Use PiP：computer-use 跑起来时，自动在右上角悬浮窗实时显示其操作截图，
 * 提升自主操作的透明度 / 信任感。
 *
 * - 检测：带 `computerSurfaceSnapshot.screenshotPath` 的 `tool_call_end`（不依赖工具名）。
 * - 首帧自动 `pip_show`，每帧 path → `appshots_read_image_data_url` 转 dataURL → `pip_frame`。
 * - run 结束（agent_complete/cancelled/stream_end/error）→ `pip_hide`。
 * - Tauri 不可用（web 模式）→ 全程静默 no-op。
 *
 * 在 App 顶层挂载一次（与 useAppshots 并列）。
 */
export function useComputerUsePip(): void {
  const activeRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const hide = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      void tauriInvoke('pip_hide').catch(() => {});
    };

    const pushFrame = async (screenshotPath: string) => {
      try {
        if (!activeRef.current) {
          activeRef.current = true;
          await tauriInvoke('pip_show');
        }
        const dataUrl = await tauriInvoke<string>('appshots_read_image_data_url', {
          path: screenshotPath,
        });
        if (!disposed && dataUrl) {
          await tauriInvoke('pip_frame', { dataUrl });
        }
      } catch {
        // Tauri 不可用 / 读图失败 → 忽略，不影响主流程
      }
    };

    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
      if (disposed) return;
      if (event.type === 'tool_call_end') {
        const path = extractSurfaceScreenshotPath(event.data);
        if (path) void pushFrame(path);
        return;
      }
      if (RUN_END_EVENTS.has(event.type)) {
        hide();
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      hide();
    };
  }, []);
}
