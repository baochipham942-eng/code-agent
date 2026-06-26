import { useEffect, useRef } from 'react';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { invokeNativeCommandAction } from '../services/nativeCommandFacade';
import type { AgentPointerEvent } from '@shared/contract';
import { isAgentPointerEvent } from '../stores/agentPointerStore';
import { composeAgentPointerFrame } from '../utils/agentPointerFrame';

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

function extractSurfaceAgentPointerEvent(data: unknown): AgentPointerEvent | undefined {
  const meta = (
    data as
      | { metadata?: { agentPointerEvent?: unknown; browserComputerProof?: { agentPointerEvent?: unknown } } }
      | undefined
  )?.metadata;
  if (isAgentPointerEvent(meta?.agentPointerEvent)) {
    return meta.agentPointerEvent;
  }
  if (isAgentPointerEvent(meta?.browserComputerProof?.agentPointerEvent)) {
    return meta.browserComputerProof.agentPointerEvent;
  }
  return undefined;
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
      void invokeNativeCommandAction('hidePip').catch(() => {});
    };

    const pushFrame = async (screenshotPath: string, pointerEvent?: AgentPointerEvent) => {
      try {
        if (!activeRef.current) {
          activeRef.current = true;
          await invokeNativeCommandAction('showPip');
        }
        const dataUrl = await invokeNativeCommandAction('readAppshotImageDataUrl', {
          path: screenshotPath,
        });
        if (!disposed && dataUrl) {
          const framedDataUrl = pointerEvent
            ? await composeAgentPointerFrame(dataUrl, pointerEvent)
            : dataUrl;
          await invokeNativeCommandAction('framePip', { dataUrl: framedDataUrl });
        }
      } catch {
        // Tauri 不可用 / 读图失败 → 忽略，不影响主流程
      }
    };

    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
      if (disposed) return;
      if (event.type === 'tool_call_end') {
        const path = extractSurfaceScreenshotPath(event.data);
        if (path) void pushFrame(path, extractSurfaceAgentPointerEvent(event.data));
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
