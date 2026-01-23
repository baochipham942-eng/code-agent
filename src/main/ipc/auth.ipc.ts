// ============================================================================
// Auth IPC Handlers - auth:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AuthUser, AuthStatus } from '../../shared/types';
import { getAuthService } from '../services';
import { getSecureStorage } from '../services/core/secureStorage';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleGetStatus(): Promise<AuthStatus> {
  return getAuthService().getStatus();
}

async function handleSignInEmail(payload: { email: string; password: string }) {
  return getAuthService().signInWithEmail(payload.email, payload.password);
}

async function handleSignUpEmail(payload: { email: string; password: string; inviteCode?: string }) {
  return getAuthService().signUpWithEmail(payload.email, payload.password, payload.inviteCode);
}

async function handleSignInOAuth(payload: { provider: 'github' | 'google' }) {
  await getAuthService().signInWithOAuth(payload.provider);
}

async function handleSignInToken(payload: { token: string }) {
  return getAuthService().signInWithQuickToken(payload.token);
}

async function handleSignOut(): Promise<void> {
  await getAuthService().signOut();
}

async function handleGetUser(): Promise<AuthUser | null> {
  return getAuthService().getCurrentUser();
}

async function handleUpdateProfile(payload: { updates: Partial<AuthUser> }) {
  return getAuthService().updateProfile(payload.updates);
}

async function handleGenerateQuickToken(): Promise<string | null> {
  return getAuthService().generateQuickLoginToken();
}

// ========== Saved Credentials Handlers ==========

function handleSaveCredentials(payload: { email: string; password: string }): void {
  getSecureStorage().saveLoginCredentials(payload.email, payload.password);
}

function handleGetSavedCredentials(): { email: string; password: string } | null {
  return getSecureStorage().getSavedCredentials();
}

function handleClearSavedCredentials(): void {
  getSecureStorage().clearSavedCredentials();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Auth 相关 IPC handlers
 */
export function registerAuthHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.AUTH, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'getStatus':
          data = await handleGetStatus();
          break;
        case 'signInEmail':
          data = await handleSignInEmail(payload as { email: string; password: string });
          break;
        case 'signUpEmail':
          data = await handleSignUpEmail(payload as { email: string; password: string; inviteCode?: string });
          break;
        case 'signInOAuth':
          await handleSignInOAuth(payload as { provider: 'github' | 'google' });
          data = null;
          break;
        case 'signInToken':
          data = await handleSignInToken(payload as { token: string });
          break;
        case 'signOut':
          await handleSignOut();
          data = null;
          break;
        case 'getUser':
          data = await handleGetUser();
          break;
        case 'updateProfile':
          data = await handleUpdateProfile(payload as { updates: Partial<AuthUser> });
          break;
        case 'generateQuickToken':
          data = await handleGenerateQuickToken();
          break;
        case 'saveCredentials':
          handleSaveCredentials(payload as { email: string; password: string });
          data = null;
          break;
        case 'getSavedCredentials':
          data = handleGetSavedCredentials();
          break;
        case 'clearSavedCredentials':
          handleClearSavedCredentials();
          data = null;
          break;
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'getStatus' */
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async () => handleGetStatus());

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'signInEmail' */
  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN_EMAIL, async (_, email: string, password: string) =>
    handleSignInEmail({ email, password })
  );

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'signUpEmail' */
  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_UP_EMAIL, async (_, email: string, password: string, inviteCode?: string) =>
    handleSignUpEmail({ email, password, inviteCode })
  );

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'signInOAuth' */
  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN_OAUTH, async (_, provider: 'github' | 'google') =>
    handleSignInOAuth({ provider })
  );

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'signInToken' */
  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN_TOKEN, async (_, token: string) =>
    handleSignInToken({ token })
  );

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'signOut' */
  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_OUT, async () => handleSignOut());

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'getUser' */
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => handleGetUser());

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'updateProfile' */
  ipcMain.handle(IPC_CHANNELS.AUTH_UPDATE_PROFILE, async (_, updates: Partial<AuthUser>) =>
    handleUpdateProfile({ updates })
  );

  /** @deprecated Use IPC_DOMAINS.AUTH with action: 'generateQuickToken' */
  ipcMain.handle(IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN, async () => handleGenerateQuickToken());
}
