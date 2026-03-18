// ============================================================================
// Platform: IPC Registry - 替代 Electron ipcMain 运行时对象
// ============================================================================
//
// Map-based handler 注册表。
// Web 模式下 webServer 从 handlers Map 读取来路由 HTTP 请求。
//
// ============================================================================

import type { HandlerFn, IpcMain } from './ipcTypes';

/** 所有通过 ipcMain.handle() 注册的 handler */
export const handlers = new Map<string, HandlerFn>();

/** 所有通过 ipcMain.on() 注册的 listener */
export const eventListeners = new Map<string, HandlerFn>();

/**
 * ipcMain 运行时 — 兼容 Electron ipcMain API
 */
export const ipcMain: IpcMain & {
  removeHandler(channel: string): void;
  removeAllListeners(channel?: string): void;
} = {
  handle(channel: string, handler: HandlerFn): void {
    handlers.set(channel, handler);
  },
  on(channel: string, handler: HandlerFn): void {
    eventListeners.set(channel, handler);
  },
  once(_channel: string, _handler: HandlerFn): void {
    // no-op in web mode
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  removeAllListeners(channel?: string): void {
    if (channel) {
      eventListeners.delete(channel);
    } else {
      eventListeners.clear();
    }
  },
};
