// ============================================================================
// Auth Store - Frontend authentication state management
// ============================================================================

import { create } from 'zustand';
import type { AuthUser, SyncStatus } from '../../shared/contract';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../shared/ipc';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('AuthStore');

async function invokeDomain<T>(domain: string, action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(domain, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `${domain}:${action} failed`);
  }
  return response.data as T;
}

interface AuthState {
  // Auth state
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;

  // Sync state
  syncStatus: SyncStatus;

  // UI state
  showAuthModal: boolean;
  showPasswordResetModal: boolean;
  passwordResetTokens: { accessToken: string; refreshToken: string } | null;

  // Setters
  setUser: (user: AuthUser | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSyncStatus: (status: SyncStatus) => void;
  setShowAuthModal: (show: boolean) => void;
  setShowPasswordResetModal: (show: boolean) => void;
  setPasswordResetTokens: (tokens: { accessToken: string; refreshToken: string } | null) => void;

  // Auth actions
  signInWithEmail: (email: string, password: string) => Promise<boolean>;
  signUpWithEmail: (
    email: string,
    password: string,
    inviteCode?: string
  ) => Promise<boolean>;
  signInWithOAuth: (provider: 'github' | 'google') => Promise<void>;
  signInWithToken: (token: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<AuthUser>) => Promise<boolean>;
  generateQuickToken: () => Promise<string | null>;
  resetPassword: (email: string) => Promise<boolean>;
  updatePassword: (newPassword: string) => Promise<boolean>;
  handlePasswordResetCallback: (accessToken: string, refreshToken: string) => Promise<boolean>;

  // Sync actions
  startSync: () => Promise<void>;
  stopSync: () => Promise<void>;
  forceFullSync: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  // Initial state
  isAuthenticated: false,
  user: null,
  isLoading: true,
  error: null,
  syncStatus: {
    isEnabled: false,
    isSyncing: false,
    lastSyncAt: null,
    pendingChanges: 0,
  },
  showAuthModal: false,
  showPasswordResetModal: false,
  passwordResetTokens: null,

  // Setters
  setUser: (user) =>
    set({
      user,
      isAuthenticated: !!user,
      error: null,
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setShowAuthModal: (showAuthModal) => set({ showAuthModal }),
  setShowPasswordResetModal: (showPasswordResetModal) => set({ showPasswordResetModal }),
  setPasswordResetTokens: (passwordResetTokens) => set({ passwordResetTokens }),

  // Auth actions
  signInWithEmail: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'signInEmail', { email, password });
      if (result?.success && result.user) {
        set({
          user: result.user,
          isAuthenticated: true,
          isLoading: false,
          showAuthModal: false,
        });
        return true;
      }
      set({ error: result?.error || '登录失败', isLoading: false });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  signUpWithEmail: async (email, password, inviteCode) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'signUpEmail', { email, password, inviteCode });
      if (result?.success && result.user) {
        set({
          user: result.user,
          isAuthenticated: true,
          isLoading: false,
          showAuthModal: false,
        });
        return true;
      }
      set({ error: result?.error || '注册失败', isLoading: false });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  signInWithOAuth: async (provider) => {
    set({ isLoading: true, error: null });
    try {
      await invokeDomain(IPC_DOMAINS.AUTH, 'signInOAuth', { provider });
      // OAuth flow opens external browser, auth state will be updated via event
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  signInWithToken: async (token) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'signInToken', { token });
      if (result?.success && result.user) {
        set({
          user: result.user,
          isAuthenticated: true,
          isLoading: false,
          showAuthModal: false,
        });
        return true;
      }
      set({ error: result?.error || '快捷登录失败', isLoading: false });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  signOut: async () => {
    try {
      await invokeDomain(IPC_DOMAINS.AUTH, 'signOut');
      set({
        user: null,
        isAuthenticated: false,
        syncStatus: { ...get().syncStatus, isEnabled: false },
      });
    } catch (error) {
      logger.error('Sign out failed', error);
    }
  },

  updateProfile: async (updates) => {
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'updateProfile', { updates });
      if (result?.success && result.user) {
        set({ user: result.user });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Update profile failed', error);
      return false;
    }
  },

  generateQuickToken: async () => {
    try {
      const token = await invokeDomain<string | null>(IPC_DOMAINS.AUTH, 'generateQuickToken');
      return token ?? null;
    } catch (error) {
      logger.error('Generate quick token failed', error);
      return null;
    }
  },

  resetPassword: async (email) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'resetPassword', { email });
      set({ isLoading: false });
      if (result?.success) {
        return true;
      }
      set({ error: result?.error || '发送重置邮件失败' });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  updatePassword: async (newPassword) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'updatePassword', { password: newPassword });
      if (result?.success) {
        set({
          isLoading: false,
          showPasswordResetModal: false,
          passwordResetTokens: null,
        });
        return true;
      }
      set({ error: result?.error || '更新密码失败', isLoading: false });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  handlePasswordResetCallback: async (accessToken, refreshToken) => {
    set({ isLoading: true, error: null });
    try {
      const result = await window.domainAPI?.invoke('auth', 'passwordResetCallback', {
        accessToken,
        refreshToken,
      });
      if (result?.success) {
        // Session set successfully, show password reset modal
        set({
          isLoading: false,
          showPasswordResetModal: true,
          passwordResetTokens: { accessToken, refreshToken },
        });
        return true;
      }
      set({ error: result?.error?.message || '验证重置链接失败', isLoading: false });
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  // Sync actions
  startSync: async () => {
    try {
      await invokeDomain(IPC_DOMAINS.SYNC, 'start');
      set((state) => ({
        syncStatus: { ...state.syncStatus, isEnabled: true },
      }));
    } catch (error) {
      logger.error('Start sync failed', error);
    }
  },

  stopSync: async () => {
    try {
      await invokeDomain(IPC_DOMAINS.SYNC, 'stop');
      set((state) => ({
        syncStatus: { ...state.syncStatus, isEnabled: false },
      }));
    } catch (error) {
      logger.error('Stop sync failed', error);
    }
  },

  forceFullSync: async () => {
    try {
      const result = await invokeDomain<{ success: boolean; error?: string }>(IPC_DOMAINS.SYNC, 'forceFull');
      return result?.success ?? false;
    } catch (error) {
      logger.error('Force full sync failed', error);
      return false;
    }
  },
}));

// Initialize auth store: load status and set up event listeners
export async function initializeAuthStore(): Promise<void> {
  const store = useAuthStore.getState();

  // Load current auth status
  try {
    const status = await invokeDomain<any>(IPC_DOMAINS.AUTH, 'getStatus');
    if (status) {
      store.setUser(status.user);
    }
  } catch (error) {
    logger.error('Failed to load auth status', error);
  } finally {
    store.setLoading(false);
  }

  // Load sync status
  try {
    const syncStatus = await invokeDomain<SyncStatus>(IPC_DOMAINS.SYNC, 'getStatus');
    if (syncStatus) {
      store.setSyncStatus(syncStatus);
    }
  } catch (error) {
    logger.error('Failed to load sync status', error);
  }

  // Listen for auth events
  ipcService.on(IPC_CHANNELS.AUTH_EVENT, (event) => {
    if (event.type === 'signed_in' && event.user) {
      store.setUser(event.user);
      store.setLoading(false);
      store.setShowAuthModal(false);
    } else if (event.type === 'signed_out') {
      store.setUser(null);
    } else if (event.type === 'user_updated' && event.user) {
      store.setUser(event.user);
    }
  });

  // Listen for sync events
  ipcService.on(IPC_CHANNELS.SYNC_EVENT, (status) => {
    store.setSyncStatus(status);
  });

  // Listen for password reset callback (from deep link)
  ipcService.on(
    IPC_CHANNELS.AUTH_PASSWORD_RESET_CALLBACK,
    (data: { accessToken: string; refreshToken: string }) => {
      logger.info('Received password reset callback');
      store.handlePasswordResetCallback(data.accessToken, data.refreshToken);
    }
  );
}
