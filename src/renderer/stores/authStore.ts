// ============================================================================
// Auth Store - Frontend authentication state management
// ============================================================================

import { create } from 'zustand';
import type { AuthUser, SyncStatus } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc';
import { createLogger } from '../utils/logger';

const logger = createLogger('AuthStore');

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

  // Setters
  setUser: (user: AuthUser | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSyncStatus: (status: SyncStatus) => void;
  setShowAuthModal: (show: boolean) => void;

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

  // Auth actions
  signInWithEmail: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const result = await window.electronAPI?.invoke(
        IPC_CHANNELS.AUTH_SIGN_IN_EMAIL,
        email,
        password
      );
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
      const result = await window.electronAPI?.invoke(
        IPC_CHANNELS.AUTH_SIGN_UP_EMAIL,
        email,
        password,
        inviteCode
      );
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
      await window.electronAPI?.invoke(IPC_CHANNELS.AUTH_SIGN_IN_OAUTH, provider);
      // OAuth flow opens external browser, auth state will be updated via event
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  signInWithToken: async (token) => {
    set({ isLoading: true, error: null });
    try {
      const result = await window.electronAPI?.invoke(
        IPC_CHANNELS.AUTH_SIGN_IN_TOKEN,
        token
      );
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
      await window.electronAPI?.invoke(IPC_CHANNELS.AUTH_SIGN_OUT);
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
      const result = await window.electronAPI?.invoke(
        IPC_CHANNELS.AUTH_UPDATE_PROFILE,
        updates
      );
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
      const token = await window.electronAPI?.invoke(
        IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN
      );
      return token ?? null;
    } catch (error) {
      logger.error('Generate quick token failed', error);
      return null;
    }
  },

  // Sync actions
  startSync: async () => {
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_START);
      set((state) => ({
        syncStatus: { ...state.syncStatus, isEnabled: true },
      }));
    } catch (error) {
      logger.error('Start sync failed', error);
    }
  },

  stopSync: async () => {
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_STOP);
      set((state) => ({
        syncStatus: { ...state.syncStatus, isEnabled: false },
      }));
    } catch (error) {
      logger.error('Stop sync failed', error);
    }
  },

  forceFullSync: async () => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_FORCE_FULL);
      return result?.success ?? false;
    } catch (error) {
      logger.error('Force full sync failed', error);
      return false;
    }
  },
}));

/**
 * 管理员自动同步云端 API Key
 * 在管理员登录后自动调用，将系统 API Key 同步到本地
 */
async function syncApiKeysForAdmin(user: AuthUser): Promise<void> {
  if (!user.isAdmin) {
    return;
  }

  logger.info('Admin detected, syncing API keys from cloud...');

  try {
    // 获取 auth token
    const token = await window.electronAPI?.invoke(IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN);
    if (!token) {
      logger.warn('Failed to get auth token for API key sync');
      return;
    }

    // 调用同步接口
    const result = await window.domainAPI?.invoke<{
      success: boolean;
      syncedKeys: string[];
      error?: string;
    }>('settings', 'syncApiKeysFromCloud', { authToken: token });

    if (result?.success && result.data?.success) {
      const syncedKeys = result.data.syncedKeys;
      if (syncedKeys.length > 0) {
        logger.info('Admin API keys synced successfully', { syncedKeys });
      } else {
        logger.info('No API keys to sync from cloud');
      }
    } else {
      logger.warn('Failed to sync admin API keys', { error: result?.data?.error || result?.error });
    }
  } catch (error) {
    logger.error('Error syncing admin API keys', error);
  }
}

// Initialize auth store: load status and set up event listeners
export async function initializeAuthStore(): Promise<void> {
  const store = useAuthStore.getState();

  // Load current auth status
  try {
    const status = await window.electronAPI?.invoke(IPC_CHANNELS.AUTH_GET_STATUS);
    if (status) {
      store.setUser(status.user);

      // 管理员自动同步 API Key
      if (status.user?.isAdmin) {
        // 延迟执行，避免阻塞初始化
        setTimeout(() => syncApiKeysForAdmin(status.user), 1000);
      }
    }
  } catch (error) {
    logger.error('Failed to load auth status', error);
  } finally {
    store.setLoading(false);
  }

  // Load sync status
  try {
    const syncStatus = await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_GET_STATUS);
    if (syncStatus) {
      store.setSyncStatus(syncStatus);
    }
  } catch (error) {
    logger.error('Failed to load sync status', error);
  }

  // Listen for auth events
  window.electronAPI?.on(IPC_CHANNELS.AUTH_EVENT, (event) => {
    if (event.type === 'signed_in' && event.user) {
      store.setUser(event.user);
      store.setLoading(false);
      store.setShowAuthModal(false);

      // 管理员登录后自动同步 API Key
      if (event.user.isAdmin) {
        setTimeout(() => syncApiKeysForAdmin(event.user), 1000);
      }
    } else if (event.type === 'signed_out') {
      store.setUser(null);
    } else if (event.type === 'user_updated' && event.user) {
      store.setUser(event.user);
    }
  });

  // Listen for sync events
  window.electronAPI?.on(IPC_CHANNELS.SYNC_EVENT, (status) => {
    store.setSyncStatus(status);
  });
}
