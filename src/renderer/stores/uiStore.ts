// ============================================================================
// UI Store - UI State Management
// ============================================================================

import { create } from 'zustand';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ModalType =
  | 'settings'
  | 'auth'
  | 'confirm'
  | 'permission'
  | 'userQuestion'
  | 'forceUpdate';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  variant?: 'danger' | 'warning' | 'info';
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
}

// -----------------------------------------------------------------------------
// State Interface
// -----------------------------------------------------------------------------

interface UIState {
  // Modal State
  activeModals: Set<ModalType>;
  confirmOptions: ConfirmOptions | null;

  // Toast State
  toasts: Toast[];

  // Actions - Modal
  openModal: (modal: ModalType) => void;
  closeModal: (modal: ModalType) => void;
  toggleModal: (modal: ModalType) => void;
  isModalOpen: (modal: ModalType) => boolean;
  closeAllModals: () => void;

  // Actions - Confirm Dialog
  showConfirm: (options: ConfirmOptions) => void;
  hideConfirm: () => void;

  // Actions - Toast
  showToast: (type: ToastType, message: string, duration?: number) => string;
  hideToast: (id: string) => void;
  clearToasts: () => void;
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIState>((set, get) => ({
  // Initial State
  activeModals: new Set(),
  confirmOptions: null,
  toasts: [],

  // Modal Actions
  openModal: (modal) => {
    set((state) => {
      const newModals = new Set(state.activeModals);
      newModals.add(modal);
      return { activeModals: newModals };
    });
  },

  closeModal: (modal) => {
    set((state) => {
      const newModals = new Set(state.activeModals);
      newModals.delete(modal);
      return { activeModals: newModals };
    });
  },

  toggleModal: (modal) => {
    const state = get();
    if (state.activeModals.has(modal)) {
      state.closeModal(modal);
    } else {
      state.openModal(modal);
    }
  },

  isModalOpen: (modal) => {
    return get().activeModals.has(modal);
  },

  closeAllModals: () => {
    set({ activeModals: new Set(), confirmOptions: null });
  },

  // Confirm Dialog Actions
  showConfirm: (options) => {
    set({ confirmOptions: options });
    get().openModal('confirm');
  },

  hideConfirm: () => {
    set({ confirmOptions: null });
    get().closeModal('confirm');
  },

  // Toast Actions
  showToast: (type, message, duration = 5000) => {
    const id = generateId();
    const toast: Toast = { id, type, message, duration };

    set((state) => ({
      toasts: [...state.toasts, toast],
    }));

    // Auto-dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        get().hideToast(id);
      }, duration);
    }

    return id;
  },

  hideToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },
}));

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Hook to get toast functions
 */
export function useToast() {
  const showToast = useUIStore((state) => state.showToast);
  const hideToast = useUIStore((state) => state.hideToast);

  return {
    success: (message: string, duration?: number) => showToast('success', message, duration),
    error: (message: string, duration?: number) => showToast('error', message, duration),
    warning: (message: string, duration?: number) => showToast('warning', message, duration),
    info: (message: string, duration?: number) => showToast('info', message, duration),
    hide: hideToast,
  };
}

/**
 * Hook to manage a specific modal
 */
export function useModal(modalType: ModalType) {
  const isOpen = useUIStore((state) => state.activeModals.has(modalType));
  const openModal = useUIStore((state) => state.openModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const toggleModal = useUIStore((state) => state.toggleModal);

  return {
    isOpen,
    open: () => openModal(modalType),
    close: () => closeModal(modalType),
    toggle: () => toggleModal(modalType),
  };
}

/**
 * Hook to manage confirm dialog
 */
export function useConfirm() {
  const showConfirm = useUIStore((state) => state.showConfirm);
  const hideConfirm = useUIStore((state) => state.hideConfirm);
  const confirmOptions = useUIStore((state) => state.confirmOptions);
  const isOpen = useUIStore((state) => state.activeModals.has('confirm'));

  return {
    isOpen,
    options: confirmOptions,
    show: showConfirm,
    hide: hideConfirm,
  };
}
