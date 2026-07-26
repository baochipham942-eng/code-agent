// ============================================================================
// useToast - Global toast notification hook
// ============================================================================

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  /** 可选动作按钮（如「不再提示」）；点击后 toast 立即关闭 */
  action?: ToastAction;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number, action?: ToastAction) => void;
  removeToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (type, message, duration = 4000, action) => {
    const id = `toast-${++nextId}`;
    set((state) => ({
      toasts: [...state.toasts, { id, type, message, duration, action }],
    }));
    // Auto-remove after duration
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, duration);
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

/** Convenience function for showing toasts (can be called from non-React code) */
export const toast = {
  success: (msg: string) => useToastStore.getState().addToast('success', msg),
  error: (msg: string) => useToastStore.getState().addToast('error', msg, 6000),
  info: (msg: string) => useToastStore.getState().addToast('info', msg),
  warning: (msg: string, action?: ToastAction, duration = 5000) =>
    useToastStore.getState().addToast('warning', msg, duration, action),
};
