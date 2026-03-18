// ============================================================================
// Platform: Notifications - 替代 Electron Notification
// ============================================================================

import { exec } from 'child_process';

interface NotificationOptions {
  title?: string;
  body?: string;
  icon?: unknown;
  [key: string]: unknown;
}

/**
 * 原生通知 — macOS 使用 osascript，其他平台 no-op
 */
export class Notification {
  private options: NotificationOptions;

  constructor(options?: NotificationOptions) {
    this.options = options || {};
  }

  show(): void {
    if (process.platform === 'darwin') {
      const title = (this.options.title || '').replace(/"/g, '\\"');
      const body = (this.options.body || '').replace(/"/g, '\\"');
      exec(`osascript -e 'display notification "${body}" with title "${title}"'`);
    }
  }

  close(): void {}
  on(..._args: unknown[]) { return this; }

  static isSupported(): boolean {
    return process.platform === 'darwin';
  }
}
