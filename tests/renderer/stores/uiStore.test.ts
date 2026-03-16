// ============================================================================
// uiStore.test.ts - UI 状态管理 store 测试
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @shared/constants before importing the store
vi.mock('../../../src/shared/constants/ui', () => ({
  UI: { TOAST_DURATION: 5000 },
}));

import { useUIStore } from '../../../src/renderer/stores/uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store
    useUIStore.setState({
      activeModals: new Set(),
      confirmOptions: null,
      toasts: [],
      deepResearch: {
        mode: 'normal',
        reportStyle: 'default',
        progress: {
          isActive: false,
          phase: 'planning',
          message: '',
          percent: 0,
        },
      },
    });
  });

  // ============================================================================
  // Modal management
  // ============================================================================

  describe('modal management', () => {
    it('should open a modal', () => {
      useUIStore.getState().openModal('settings');
      expect(useUIStore.getState().activeModals.has('settings')).toBe(true);
    });

    it('should close a modal', () => {
      useUIStore.getState().openModal('settings');
      useUIStore.getState().closeModal('settings');
      expect(useUIStore.getState().activeModals.has('settings')).toBe(false);
    });

    it('should toggle a modal on', () => {
      useUIStore.getState().toggleModal('auth');
      expect(useUIStore.getState().activeModals.has('auth')).toBe(true);
    });

    it('should toggle a modal off', () => {
      useUIStore.getState().openModal('auth');
      useUIStore.getState().toggleModal('auth');
      expect(useUIStore.getState().activeModals.has('auth')).toBe(false);
    });

    it('should check if modal is open', () => {
      useUIStore.getState().openModal('settings');
      expect(useUIStore.getState().isModalOpen('settings')).toBe(true);
      expect(useUIStore.getState().isModalOpen('auth')).toBe(false);
    });

    it('should support multiple modals open simultaneously', () => {
      useUIStore.getState().openModal('settings');
      useUIStore.getState().openModal('auth');
      expect(useUIStore.getState().activeModals.size).toBe(2);
    });

    it('should close all modals', () => {
      useUIStore.getState().openModal('settings');
      useUIStore.getState().openModal('auth');
      useUIStore.getState().closeAllModals();
      expect(useUIStore.getState().activeModals.size).toBe(0);
      expect(useUIStore.getState().confirmOptions).toBeNull();
    });
  });

  // ============================================================================
  // Confirm dialog
  // ============================================================================

  describe('confirm dialog', () => {
    it('should show confirm with options', () => {
      const options = { title: 'Delete?', message: 'Are you sure?' };
      useUIStore.getState().showConfirm(options);

      expect(useUIStore.getState().confirmOptions).toEqual(options);
      expect(useUIStore.getState().activeModals.has('confirm')).toBe(true);
    });

    it('should hide confirm', () => {
      useUIStore.getState().showConfirm({ title: 'Test', message: 'Test' });
      useUIStore.getState().hideConfirm();

      expect(useUIStore.getState().confirmOptions).toBeNull();
      expect(useUIStore.getState().activeModals.has('confirm')).toBe(false);
    });
  });

  // ============================================================================
  // Toast management
  // ============================================================================

  describe('toast management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should show a toast and return its id', () => {
      const id = useUIStore.getState().showToast('success', 'Saved!');
      expect(id).toBeTruthy();
      expect(useUIStore.getState().toasts).toHaveLength(1);
      expect(useUIStore.getState().toasts[0].message).toBe('Saved!');
      expect(useUIStore.getState().toasts[0].type).toBe('success');
    });

    it('should support all toast types', () => {
      for (const type of ['success', 'error', 'warning', 'info'] as const) {
        useUIStore.getState().showToast(type, `msg-${type}`);
      }
      expect(useUIStore.getState().toasts).toHaveLength(4);
    });

    it('should hide a specific toast', () => {
      const id = useUIStore.getState().showToast('info', 'msg', 0);
      useUIStore.getState().hideToast(id);
      expect(useUIStore.getState().toasts).toHaveLength(0);
    });

    it('should clear all toasts', () => {
      useUIStore.getState().showToast('info', 'a', 0);
      useUIStore.getState().showToast('info', 'b', 0);
      useUIStore.getState().clearToasts();
      expect(useUIStore.getState().toasts).toHaveLength(0);
    });

    it('should auto-dismiss toast after duration', () => {
      useUIStore.getState().showToast('success', 'temp', 3000);
      expect(useUIStore.getState().toasts).toHaveLength(1);

      vi.advanceTimersByTime(3000);
      expect(useUIStore.getState().toasts).toHaveLength(0);
    });

    it('should not auto-dismiss when duration is 0', () => {
      useUIStore.getState().showToast('success', 'permanent', 0);
      vi.advanceTimersByTime(10000);
      expect(useUIStore.getState().toasts).toHaveLength(1);
    });
  });

  // ============================================================================
  // Deep Research state
  // ============================================================================

  describe('deep research', () => {
    it('should set mode', () => {
      useUIStore.getState().setDeepResearchMode('deep-research');
      expect(useUIStore.getState().deepResearch.mode).toBe('deep-research');
    });

    it('should set report style', () => {
      useUIStore.getState().setReportStyle('academic');
      expect(useUIStore.getState().deepResearch.reportStyle).toBe('academic');
    });

    it('should update research progress', () => {
      useUIStore.getState().updateResearchProgress({
        phase: 'researching',
        message: 'Searching...',
        percent: 30,
      });

      const progress = useUIStore.getState().deepResearch.progress;
      expect(progress.phase).toBe('researching');
      expect(progress.message).toBe('Searching...');
      expect(progress.percent).toBe(30);
      expect(progress.isActive).toBe(true);
    });

    it('should set isActive=false when phase is complete', () => {
      useUIStore.getState().updateResearchProgress({ phase: 'complete' });
      expect(useUIStore.getState().deepResearch.progress.isActive).toBe(false);
    });

    it('should set isActive=false when phase is error', () => {
      useUIStore.getState().updateResearchProgress({ phase: 'error' });
      expect(useUIStore.getState().deepResearch.progress.isActive).toBe(false);
    });

    it('should reset research progress', () => {
      useUIStore.getState().updateResearchProgress({
        phase: 'reporting',
        percent: 80,
        message: 'Generating report...',
      });
      useUIStore.getState().resetResearchProgress();

      const progress = useUIStore.getState().deepResearch.progress;
      expect(progress.isActive).toBe(false);
      expect(progress.phase).toBe('planning');
      expect(progress.percent).toBe(0);
      expect(progress.message).toBe('');
    });

    it('should preserve mode when resetting progress', () => {
      useUIStore.getState().setDeepResearchMode('deep-research');
      useUIStore.getState().resetResearchProgress();
      expect(useUIStore.getState().deepResearch.mode).toBe('deep-research');
    });
  });
});
