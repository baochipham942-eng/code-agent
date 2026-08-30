import { create } from 'zustand';
import type {
  BundledHostCapabilityId,
  BundledHostCapabilityState,
} from '@shared/contract/bundledHostCapability';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';

const EMPTY_INSTALLED: Record<BundledHostCapabilityId, boolean> = {
  'builtin.voice-live': false,
  'builtin.voice-input': false,
};

interface BundledCapabilityStoreState {
  installed: Record<BundledHostCapabilityId, boolean>;
  states: BundledHostCapabilityState[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useBundledCapabilityStore = create<BundledCapabilityStoreState>((set) => ({
  installed: EMPTY_INSTALLED,
  states: [],
  loaded: false,
  error: null,
  refresh: async () => {
    try {
      const states = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_STATE_LIST);
      const installed = { ...EMPTY_INSTALLED };
      for (const state of states ?? []) installed[state.id] = state.installed;
      set({ installed, states: states ?? [], loaded: true, error: null });
    } catch (error) {
      set({
        installed: { ...EMPTY_INSTALLED },
        states: [],
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

export function installedBundledCapabilityIds(): ReadonlySet<BundledHostCapabilityId> {
  const { installed } = useBundledCapabilityStore.getState();
  return new Set(
    (Object.keys(installed) as BundledHostCapabilityId[]).filter((id) => installed[id]),
  );
}

export function subscribeBundledCapabilityState(): () => void {
  const refresh = useBundledCapabilityStore.getState().refresh;
  void refresh();
  return ipcService.on(IPC_CHANNELS.CAPABILITY_STATE_CHANGED, () => {
    void useBundledCapabilityStore.getState().refresh();
  }) ?? (() => undefined);
}
