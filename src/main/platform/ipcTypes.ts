// ============================================================================
// Platform: IPC Types - 替代 Electron IPC 类型
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerFn = (event: any, ...args: any[]) => any;

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

/** IpcMainInvokeEvent — ipcMain.handle 回调的第一个参数 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcMainInvokeEvent = any;

/** IpcMainEvent — ipcMain.on 回调的第一个参数 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcMainEvent = any;

// Electron namespace 兼容
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Electron {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type IpcMainInvokeEvent = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type IpcMainEvent = any;
}
