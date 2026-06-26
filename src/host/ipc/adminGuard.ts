// ============================================================================
// Admin Guard - shared IPC access checks for admin-only surfaces
// ============================================================================

import type { IPCResponse } from '../../shared/ipc';
import { getAuthService } from '../services/auth';

export class AdminAccessError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(surface = 'Admin') {
    super(`${surface}: Admin permission required`);
    this.name = 'AdminAccessError';
  }
}

function isLocalWebAdminTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_WEB_MODE === 'true'
    && (env.CODE_AGENT_E2E === '1' || env.CODE_AGENT_ENABLE_DEV_API === 'true');
}

export function isCurrentUserAdmin(): boolean {
  if (isLocalWebAdminTestMode()) return true;

  const authService = getAuthService();
  return authService.getCurrentUser()?.isAdmin === true
    && authService.hasVerifiedSession?.() === true;
}

export function assertAdminAccess(surface?: string): void {
  if (!isCurrentUserAdmin()) {
    throw new AdminAccessError(surface);
  }
}

export function getAdminAccessIpcError(surface?: string): IPCResponse | null {
  if (isCurrentUserAdmin()) return null;
  const error = new AdminAccessError(surface);
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
