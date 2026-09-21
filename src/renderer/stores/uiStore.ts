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

// 深度研究相关类型
export type ResearchPhase = 'planning' | 'researching' | 'reporting' | 'complete' | 'error';
export type ReportStyle = 'default' | 'academic' | 'popular_science' | 'news' | 'social_media' | 'strategic_investment';

export interface ResearchProgress {
  isActive: boolean;
  phase: ResearchPhase;
  message: string;
  percent: number;
  currentStep?: {
    title: string;
    status: 'running' | 'completed' | 'failed';
  };
  error?: string;
}

export interface DeepResearchState {
  /** 当前聊天模式 */
  mode: 'normal' | 'deep-research';
  /** 选择的报告风格 */
  reportStyle: ReportStyle;
  /** 研究进度状态 */
  progress: ResearchProgress;
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

  // Deep Research State
  deepResearch: DeepResearchState;

  // Actions - Modal
  openModal: (modal: ModalType) => void;
  closeModal: (modal: ModalType) => void;
  toggleModal: (modal: ModalType) => void;
  isModalOpen: (modal: ModalType) => boolean;
  closeAllModals: () => void;

  // Actions - Confirm Dialog
  showConfirm: (options: ConfirmOptions) => void;
  hideConfirm: () => void;

  // Actions - Deep Research
  setDeepResearchMode: (mode: 'normal' | 'deep-research') => void;
  setReportStyle: (style: ReportStyle) => void;
  updateResearchProgress: (progress: Partial<ResearchProgress>) => void;
  resetResearchProgress: () => void;
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

// 深度研究初始状态
const initialDeepResearchState: DeepResearchState = {
  mode: 'normal',
  reportStyle: 'default',
  progress: {
    isActive: false,
    phase: 'planning',
    message: '',
    percent: 0,
  },
};

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useUIStore = create<UIState>((set, get) => ({
  // Initial State
  activeModals: new Set(),
  confirmOptions: null,
  deepResearch: initialDeepResearchState,

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

  // Deep Research Actions
  setDeepResearchMode: (mode) =>
    set((state) => ({
      deepResearch: { ...state.deepResearch, mode },
    })),

  setReportStyle: (style) =>
    set((state) => ({
      deepResearch: { ...state.deepResearch, reportStyle: style },
    })),

  updateResearchProgress: (progress) =>
    set((state) => ({
      deepResearch: {
        ...state.deepResearch,
        progress: {
          ...state.deepResearch.progress,
          ...progress,
          isActive: progress.phase !== 'complete' && progress.phase !== 'error',
        },
      },
    })),

  resetResearchProgress: () =>
    set((state) => ({
      deepResearch: {
        ...state.deepResearch,
        progress: initialDeepResearchState.progress,
      },
    })),
}));

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

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

/**
 * Hook to manage deep research state
 */
export function useDeepResearch() {
  const deepResearch = useUIStore((state) => state.deepResearch);
  const setMode = useUIStore((state) => state.setDeepResearchMode);
  const setReportStyle = useUIStore((state) => state.setReportStyle);
  const updateProgress = useUIStore((state) => state.updateResearchProgress);
  const resetProgress = useUIStore((state) => state.resetResearchProgress);

  return {
    mode: deepResearch.mode,
    reportStyle: deepResearch.reportStyle,
    progress: deepResearch.progress,
    isActive: deepResearch.progress.isActive,
    setMode,
    setReportStyle,
    updateProgress,
    resetProgress,
  };
}
