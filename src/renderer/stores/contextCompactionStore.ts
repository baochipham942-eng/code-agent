import { create } from 'zustand';
import type { CompactResult } from '@shared/contract/contextHealth';

export type ContextCompactionStatus = 'idle' | 'active' | 'success' | 'error';

interface ContextCompactionState {
  status: ContextCompactionStatus;
  result: CompactResult | null;
  error: string | null;
  updatedAt: number;
  start: () => void;
  succeed: (result: CompactResult) => void;
  fail: (error: string) => void;
  clear: () => void;
}

export const useContextCompactionStore = create<ContextCompactionState>((set) => ({
  status: 'idle',
  result: null,
  error: null,
  updatedAt: 0,
  start: () => set({
    status: 'active',
    result: null,
    error: null,
    updatedAt: Date.now(),
  }),
  succeed: (result) => set({
    status: 'success',
    result,
    error: null,
    updatedAt: Date.now(),
  }),
  fail: (error) => set({
    status: 'error',
    result: null,
    error,
    updatedAt: Date.now(),
  }),
  clear: () => set({
    status: 'idle',
    result: null,
    error: null,
    updatedAt: Date.now(),
  }),
}));
