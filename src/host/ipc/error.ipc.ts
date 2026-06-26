// ============================================================================
// Error IPC - Push error recovery events to renderer
// ============================================================================

import type { AppWindow } from '../platform';
import type { ErrorRecoveryEvent } from '../errors/recoveryEngine';

export function sendErrorRecoveryEvent(window: AppWindow | null, event: ErrorRecoveryEvent): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('error:recovery', event);
}
