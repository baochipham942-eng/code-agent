// ============================================================================
// Local Bridge Store - Bridge Service Connection State
// ============================================================================

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

interface LocalBridgeState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  version: string | null;
  latestVersion: string | null;
  workingDirectory: string | null;
  error: string | null;
  token: string | null;
  securityConfirmL2: boolean;

  checkHealth: () => Promise<void>;
  setWorkingDirectory: (dir: string) => void;
  setToken: (token: string) => void;
  setSecurityConfirmL2: (value: boolean) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

// ============================================================================
// Store
// ============================================================================

export const useLocalBridgeStore = create<LocalBridgeState>((set, get) => ({
  status: 'disconnected',
  version: null,
  latestVersion: null,
  workingDirectory: localStorage.getItem('bridge-working-dir'),
  error: null,
  token: localStorage.getItem('bridge-token'),
  securityConfirmL2: localStorage.getItem('bridge-security-l2') !== 'false',

  checkHealth: async () => {
    try {
      set({ status: 'connecting' });
      const token = get().token;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('http://localhost:9527/health', { headers });
      if (res.ok) {
        const data = await res.json();
        set({
          status: 'connected',
          version: data.version,
          latestVersion: data.latestVersion,
          error: null,
        });
      } else {
        set({ status: 'error', error: '桥接服务返回错误' });
      }
    } catch {
      set({ status: 'disconnected', error: null });
    }
  },

  setWorkingDirectory: (dir) => {
    localStorage.setItem('bridge-working-dir', dir);
    set({ workingDirectory: dir });
  },

  setToken: (token) => {
    localStorage.setItem('bridge-token', token);
    set({ token });
  },

  setSecurityConfirmL2: (value) => {
    localStorage.setItem('bridge-security-l2', String(value));
    set({ securityConfirmL2: value });
  },

  startPolling: () => {
    get().checkHealth();
    const interval = setInterval(() => get().checkHealth(), 5000);
    (window as any).__bridgePollInterval = interval;
  },

  stopPolling: () => {
    const interval = (window as any).__bridgePollInterval;
    if (interval) clearInterval(interval);
  },
}));
