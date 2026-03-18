// ============================================================================
// Platform: Window Bridge - 替代 Electron BrowserWindow
// ============================================================================
//
// 提供向渲染进程推送事件的能力，不依赖 Electron BrowserWindow。
// 在 Web/Tauri 模式下通过 SSE 广播；在测试中可替换为 mock。
//
// ============================================================================

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Event sender 接口 — 替代 BrowserWindow.webContents
// ---------------------------------------------------------------------------

export interface WebContentsSender {
  send(channel: string, ...args: unknown[]): void;
}

export interface WindowLike {
  id: number;
  webContents: WebContentsSender & {
    on(...args: unknown[]): void;
    once(...args: unknown[]): void;
    openDevTools(...args: unknown[]): void;
    session: { clearCache(): Promise<void> };
    getURL(): string;
    isDestroyed(): boolean;
    setWindowOpenHandler(...args: unknown[]): void;
  };
  loadURL(...args: unknown[]): Promise<void>;
  loadFile(...args: unknown[]): Promise<void>;
  show(): void;
  hide(): void;
  close(): void;
  destroy(): void;
  focus(): void;
  blur(): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  restore(): void;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isVisible(): boolean;
  isDestroyed(): boolean;
  setTitle(...args: unknown[]): void;
  getTitle(): string;
  setBounds(...args: unknown[]): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setSize(...args: unknown[]): void;
  getSize(): number[];
  on(...args: unknown[]): WindowLike;
  once(...args: unknown[]): WindowLike;
  removeListener(...args: unknown[]): WindowLike;
}

// ---------------------------------------------------------------------------
// Global event bus for renderer push
// ---------------------------------------------------------------------------

const rendererBus = new EventEmitter();
rendererBus.setMaxListeners(100);

/**
 * 向渲染进程广播事件（SSE 层订阅此 bus）
 */
export function broadcastToRenderer(channel: string, data: unknown): void {
  rendererBus.emit('push', channel, data);
}

/**
 * 监听所有推送事件（供 SSE/WebSocket 层订阅）
 */
export function onRendererPush(listener: (channel: string, data: unknown) => void): () => void {
  rendererBus.on('push', listener);
  return () => rendererBus.off('push', listener);
}

// ---------------------------------------------------------------------------
// BrowserWindow 兼容类 — 渐进迁移用
// ---------------------------------------------------------------------------

export class BrowserWindow implements WindowLike {
  id = 0;
  webContents: WindowLike['webContents'] = {
    send: (channel: string, ...args: unknown[]) => {
      broadcastToRenderer(channel, args.length === 1 ? args[0] : args);
    },
    on: (..._args: unknown[]) => {},
    once: (..._args: unknown[]) => {},
    openDevTools: (..._args: unknown[]) => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => false,
    setWindowOpenHandler: (..._args: unknown[]) => {},
  };

  constructor(_options?: Record<string, unknown>) {}

  loadURL(..._args: unknown[]) { return Promise.resolve(); }
  loadFile(..._args: unknown[]) { return Promise.resolve(); }
  show() {}
  hide() {}
  close() {}
  destroy() {}
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isVisible() { return false; }
  isDestroyed() { return true; }
  setTitle(..._args: unknown[]) {}
  getTitle() { return ''; }
  setBounds(..._args: unknown[]) {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize(..._args: unknown[]) {}
  getSize() { return [800, 600]; }
  on(..._args: unknown[]) { return this; }
  once(..._args: unknown[]) { return this; }
  removeListener(..._args: unknown[]) { return this; }

  static getAllWindows(): BrowserWindow[] { return []; }
  static getFocusedWindow(): BrowserWindow | null { return null; }
  static fromWebContents(..._args: unknown[]): BrowserWindow | null { return null; }
  static fromId(..._args: unknown[]): BrowserWindow | null { return null; }
}
