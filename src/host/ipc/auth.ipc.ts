// ============================================================================
// Auth IPC Handlers - auth:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { AuthSchemas, type AuthDomainRequest } from '../../shared/ipc/schemas/auth';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { AuthUser, AuthStatus } from '../../shared/contract';
import { getAuthService } from '../services';
import { getSecureStorage } from '../services/core/secureStorage';
import { createLogger } from '../services/infra/logger';
import { getPostHogDistinctId } from '../observability/posthogNode';

const logger = createLogger('AuthIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAuthIpcErrorMessage(error: unknown, depth = 0): string | undefined {
  if (depth > 2) return undefined;
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error) {
    return error.message || readAuthIpcErrorMessage((error as Error & { cause?: unknown }).cause, depth + 1);
  }
  if (!isRecord(error)) return undefined;

  for (const key of ['message', 'error_description', 'error', 'details', 'hint', 'code']) {
    const value = error[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    const nested = readAuthIpcErrorMessage(value, depth + 1);
    if (nested) return nested;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function getAuthIpcErrorMessage(error: unknown): string {
  return readAuthIpcErrorMessage(error) ?? 'AUTH_REQUEST_FAILED';
}

async function handleGetStatus(): Promise<AuthStatus> {
  const status = await getAuthService().getStatus();
  return {
    ...status,
    analyticsDistinctId: status.user ? getPostHogDistinctId(status.user.id) : undefined,
  };
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

// ========== Password Reset Handlers ==========

async function handleResetPassword(payload: { email: string }) {
  return getAuthService().resetPassword(payload.email);
}

async function handleUpdatePassword(payload: { password: string }) {
  return getAuthService().updatePassword(payload.password);
}

async function handlePasswordResetCallback(payload: { accessToken: string; refreshToken: string }) {
  return getAuthService().handlePasswordResetCallback(payload.accessToken, payload.refreshToken);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * auth 域单源路由表（RQ-183 续作·AUTH 刀）：原 domain switch 逐 case 平移（handler 返回 data，装配器包
 * { success: true, data }；四个无返回的 action 显式返回 null）；未知 action → INVALID_ACTION `Unknown action: <action>`
 * （装配器缺省）；抛错 → mapError：getAuthIpcErrorMessage 提取文案 + 带 action 的 warn（不记 payload，防凭据入日志）
 * + INTERNAL_ERROR。请求体为 null / 非对象时，原实现在 try 外解构抛错（IPC reject），现返回 INVALID_ACTION。
 */
const authRoutes = defineDomainRoutes<AuthDomainRequest, void>(
  AuthSchemas.REQUEST,
  {
    getStatus: () => handleGetStatus(),
    signInEmail: (_ctx, payload) => handleSignInEmail(payload as { email: string; password: string }),
    signUpEmail: (_ctx, payload) => handleSignUpEmail(payload as { email: string; password: string; inviteCode?: string }),
    signInOAuth: async (_ctx, payload) => {
      await handleSignInOAuth(payload as { provider: 'github' | 'google' });
      return null;
    },
    signInToken: (_ctx, payload) => handleSignInToken(payload as { token: string }),
    signOut: async () => {
      await handleSignOut();
      return null;
    },
    getUser: () => handleGetUser(),
    updateProfile: (_ctx, payload) => handleUpdateProfile(payload as { updates: Partial<AuthUser> }),
    generateQuickToken: () => handleGenerateQuickToken(),
    saveCredentials: (_ctx, payload) => {
      handleSaveCredentials(payload as { email: string; password: string });
      return null;
    },
    getSavedCredentials: () => handleGetSavedCredentials(),
    clearSavedCredentials: () => {
      handleClearSavedCredentials();
      return null;
    },
    resetPassword: (_ctx, payload) => handleResetPassword(payload as { email: string }),
    updatePassword: (_ctx, payload) => handleUpdatePassword(payload as { password: string }),
    passwordResetCallback: (_ctx, payload) =>
      handlePasswordResetCallback(payload as { accessToken: string; refreshToken: string }),
  },
  {
    mapError: (error, action) => {
      const message = getAuthIpcErrorMessage(error);
      logger.warn('Auth IPC action failed', { action, error: message });
      return { code: 'INTERNAL_ERROR', message };
    },
  },
);

/**
 * 注册 Auth 相关 IPC handlers
 */
export function registerAuthHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, authRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerAuthHandlers.routes = authRoutes;
