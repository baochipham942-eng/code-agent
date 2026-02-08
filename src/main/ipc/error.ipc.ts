// ============================================================================
// Error IPC - Push error recovery events to renderer
// ============================================================================

import type { BrowserWindow } from 'electron';
import type { ErrorRecoveryEvent } from '../errors/recoveryEngine';

export function sendErrorRecoveryEvent(window: BrowserWindow | null, event: ErrorRecoveryEvent): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('error:recovery', event);
}
