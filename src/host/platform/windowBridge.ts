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
 * 此刻有没有人在收 renderer 推送。
 *
 * 判据就是 bus 上的订阅数：SSE/WebSocket 层经 onRendererPush 订阅，没有订阅者
 * 就是没有渲染进程会收到广播——broadcastToRenderer 本身是 emit，静默丢弃。
 * 比 hasInteractiveUi() 精确：那个答的是「有没有人能在 UI 回答」，评测跑题时会被
 * 显式压成 false（agentAdapter 的 overrideBrowserWindowInteractionProbe），
 * 但从评测中心 UI 发起的跑法其实渲染进程健在、面板跑得动。
 */
export function hasRendererPushListener(): boolean {
  return rendererBus.listenerCount('push') > 0;
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

const liveWindows = new Set<AppWindow>();
let nextWindowId = 1;
let rendererInteractionProbe: (() => boolean) | null = null;

export function setBrowserWindowInteractionProbe(probe: (() => boolean) | null): void {
  rendererInteractionProbe = probe;
}

/**
 * 临时覆盖交互探针，返回恢复函数（恢复到覆盖前那一个，而不是清空）。
 * eval 跑题期间用：没有人答问句，AskUserQuestion 必须立刻走「用户未响应」回退，
 * 不能因为进程里挂着 AppWindow 就以为有人在看。
 */
export function overrideBrowserWindowInteractionProbe(probe: () => boolean): () => void {
  const previous = rendererInteractionProbe;
  rendererInteractionProbe = probe;
  return () => { rendererInteractionProbe = previous; };
}

/**
 * Host 侧唯一的「此刻是否有人能在 UI 回答」判定源。
 *
 * Web 模式始终有一个 AppWindow bridge，不能用 window 数量判断；webServer 注册的
 * probe 以活跃 SSE renderer 为准。桌面模式没有额外 probe 时再回退到 live window。
 */
export function hasInteractiveUi(): boolean {
  return rendererInteractionProbe ? rendererInteractionProbe() : liveWindows.size > 0;
}

export class AppWindow implements WindowLike {
  id: number;
  private _destroyed = false;
  webContents: WindowLike['webContents'] = {
    send: (channel: string, ...args: unknown[]) => {
      broadcastToRenderer(channel, args.length === 1 ? args[0] : args);
    },
    on: (..._args: unknown[]) => {},
    once: (..._args: unknown[]) => {},
    openDevTools: (..._args: unknown[]) => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => this._destroyed,
    setWindowOpenHandler: (..._args: unknown[]) => {},
  };

  constructor(_options?: Record<string, unknown>) {
    this.id = nextWindowId++;
    liveWindows.add(this);
  }

  loadURL(..._args: unknown[]) { return Promise.resolve(); }
  loadFile(..._args: unknown[]) { return Promise.resolve(); }
  show() {}
  hide() {}
  close() { this.destroy(); }
  destroy() {
    this._destroyed = true;
    liveWindows.delete(this);
  }
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isVisible() { return !this._destroyed; }
  isDestroyed() { return this._destroyed; }
  setTitle(..._args: unknown[]) {}
  getTitle() { return ''; }
  setBounds(..._args: unknown[]) {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize(..._args: unknown[]) {}
  getSize() { return [800, 600]; }
  on(..._args: unknown[]) { return this; }
  once(..._args: unknown[]) { return this; }
  removeListener(..._args: unknown[]) { return this; }

  static getAllWindows(): AppWindow[] { return Array.from(liveWindows); }
  static hasInteractiveRenderer(): boolean {
    return hasInteractiveUi();
  }
  static getFocusedWindow(): AppWindow | null {
    const iter = liveWindows.values().next();
    return iter.done ? null : iter.value;
  }
  static fromWebContents(..._args: unknown[]): AppWindow | null { return null; }
  static fromId(id: number): AppWindow | null {
    for (const win of liveWindows) {
      if (win.id === id) return win;
    }
    return null;
  }
}
