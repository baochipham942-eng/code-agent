// ============================================================================
// Handoff Store
// ============================================================================

import { create } from 'zustand';
import type {
  HandoffProposal,
  HandoffProposalStatus,
  ListHandoffProposalsInput,
} from '@shared/contract/handoff';
import { HANDOFF_CHANNELS } from '@shared/ipc/channels';
import ipcService from '../services/ipcService';

interface HandoffStore {
  items: HandoffProposal[];
  loading: boolean;
  error: string | null;
  load: (input?: ListHandoffProposalsInput) => Promise<void>;
  updateStatus: (id: string, status: HandoffProposalStatus) => Promise<HandoffProposal | null>;
  reset: () => void;
}

export const useHandoffStore = create<HandoffStore>((set) => ({
  items: [],
  loading: false,
  error: null,

  load: async (input = {}) => {
    set({ loading: true, error: null });
    try {
      const items = await ipcService.invoke(HANDOFF_CHANNELS.LIST, {
        status: 'pending',
        limit: 20,
        ...input,
      });
      set({ items: items || [], loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  updateStatus: async (id, status) => {
    try {
      const item = await ipcService.invoke(HANDOFF_CHANNELS.UPDATE_STATUS, { id, status });
      set((state) => ({
        items: status === 'pending'
          ? (item ? [item, ...state.items.filter((existing) => existing.id !== id)] : state.items)
          : state.items.filter((existing) => existing.id !== id),
      }));
      return item || null;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  reset: () => set({ items: [], loading: false, error: null }),
}));
