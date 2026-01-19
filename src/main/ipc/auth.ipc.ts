// ============================================================================
// Auth IPC Handlers - auth:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AuthUser } from '../../shared/types';
import { getAuthService } from '../services';

/**
 * 注册 Auth 相关 IPC handlers
 */
export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async () => {
    const authService = getAuthService();
    return authService.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_IN_EMAIL,
    async (_, email: string, password: string) => {
      const authService = getAuthService();
      return authService.signInWithEmail(email, password);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_UP_EMAIL,
    async (_, email: string, password: string, inviteCode?: string) => {
      const authService = getAuthService();
      return authService.signUpWithEmail(email, password, inviteCode);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_IN_OAUTH,
    async (_, provider: 'github' | 'google') => {
      const authService = getAuthService();
      await authService.signInWithOAuth(provider);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN_TOKEN, async (_, token: string) => {
    const authService = getAuthService();
    return authService.signInWithQuickToken(token);
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_OUT, async () => {
    const authService = getAuthService();
    await authService.signOut();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => {
    const authService = getAuthService();
    return authService.getCurrentUser();
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTH_UPDATE_PROFILE,
    async (_, updates: Partial<AuthUser>) => {
      const authService = getAuthService();
      return authService.updateProfile(updates);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN, async () => {
    const authService = getAuthService();
    return authService.generateQuickLoginToken();
  });
}
