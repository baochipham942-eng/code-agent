// ============================================================================
// Platform: IPC Types - 替代 Electron IPC 类型
// ============================================================================

interface PlatformIpcEvent {
  sender?: unknown;
  senderFrame?: unknown;
  reply?: (channel: string, ...args: unknown[]) => void;
  [key: string]: unknown;
}

export type IpcMainInvokeEvent = PlatformIpcEvent;
export type IpcMainEvent = PlatformIpcEvent;
export type HandlerFn = {
  bivarianceHack(event: unknown, ...args: unknown[]): unknown | Promise<unknown>;
}['bivarianceHack'];

/**
 * IpcMain 接口 — 兼容 Electron ipcMain API
 * 在 Web/CLI 模式下由 electronMock 实现（Map-based）
 * 在未来可替换为纯 HTTP router
 */
export interface IpcMain {
  handle(channel: string, handler: HandlerFn): void;
  on(channel: string, handler: HandlerFn): void;
  once?(channel: string, handler: HandlerFn): void;
  removeHandler(channel: string): void;
  removeAllListeners(channel?: string): void;
}

// Electron namespace 兼容
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Electron {
  export type IpcMainInvokeEvent = PlatformIpcEvent;
  export type IpcMainEvent = PlatformIpcEvent;
}
