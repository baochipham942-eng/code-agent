// ============================================================================
// Platform: Notifications - 替代 Electron Notification
// ============================================================================

import { EventEmitter } from 'events';
import { safeExecDetached } from '../utils/safeShell';

interface NotificationOptions {
  title?: string;
  body?: string;
  icon?: unknown;
  [key: string]: unknown;
}

// AppleScript 字符串字面量需要转义 \ 和 "
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 原生通知 — macOS 使用 osascript，其他平台 no-op
 */
export class Notification {
  private options: NotificationOptions;
  private readonly events = new EventEmitter();

  constructor(options?: NotificationOptions) {
    this.options = options || {};
  }

  show(): void {
    if (process.platform === 'darwin') {
      const title = escapeAppleScript(String(this.options.title || ''));
      const body = escapeAppleScript(String(this.options.body || ''));
      const script = `display notification "${body}" with title "${title}"`;
      safeExecDetached('osascript', ['-e', script]);
    }
  }

  close(): void {}
  on(event: string, listener: (...args: unknown[]) => void) {
    this.events.on(event, listener);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    this.events.once(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.events.off(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    return this.events.emit(event, ...args);
  }

  static isSupported(): boolean {
    return process.platform === 'darwin';
  }
}
