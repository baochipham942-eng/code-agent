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

interface BridgeHealthResponse {
  version: string | null;
  latestVersion: string | null;
}

let bridgePollInterval: ReturnType<typeof setInterval> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBridgeHealthResponse(value: unknown): BridgeHealthResponse {
  if (!isRecord(value)) {
    return { version: null, latestVersion: null };
  }

  return {
    version: typeof value.version === 'string' ? value.version : null,
    latestVersion: typeof value.latestVersion === 'string' ? value.latestVersion : null,
  };
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
        const data = parseBridgeHealthResponse(await res.json() as unknown);
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
    if (bridgePollInterval) clearInterval(bridgePollInterval);
    bridgePollInterval = setInterval(() => get().checkHealth(), 5000);
  },

  stopPolling: () => {
    if (bridgePollInterval) clearInterval(bridgePollInterval);
    bridgePollInterval = null;
  },
}));
