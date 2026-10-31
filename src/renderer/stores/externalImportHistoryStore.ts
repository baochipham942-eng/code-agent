import { create } from 'zustand';
import type { ImportHistoryEntry } from '@shared/contract/importHistory';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

interface ExternalImportHistoryState {
  entries: ImportHistoryEntry[];
  load: () => Promise<void>;
}

export const useExternalImportHistoryStore = create<ExternalImportHistoryState>((set) => ({
  entries: [],
  load: async () => {
    try {
      const entries = await ipcService.invokeDomain<ImportHistoryEntry[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listImportHistory',
      );
      set({ entries: entries ?? [] });
    } catch {
      set({ entries: [] });
    }
  },
}));
