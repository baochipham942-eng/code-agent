// ============================================================================
// sessionUIStore.test.ts - 会话 UI 状态管理测试（纯逻辑部分）
// ============================================================================
// 只测试 inputHistory 相关的纯状态逻辑，不测试涉及 IPC 调用的 softDelete/confirmDelete

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies that sessionUIStore imports
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: [],
      currentSessionId: null,
      loadSessions: vi.fn(),
      switchSession: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

describe('sessionUIStore - input history', () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      pendingDelete: null,
      filter: 'active',
      searchQuery: '',
      sessionStatusFilter: 'all',
      inputHistory: [],
      inputHistoryIndex: -1,
      inputHistoryDraft: '',
    });
  });

  // ============================================================================
  // addToInputHistory
  // ============================================================================

  describe('addToInputHistory', () => {
    it('should add trimmed input to history', () => {
      useSessionUIStore.getState().addToInputHistory('  hello world  ');
      expect(useSessionUIStore.getState().inputHistory[0]).toBe('hello world');
    });

    it('should prepend new entry (most recent first)', () => {
      useSessionUIStore.getState().addToInputHistory('first');
      useSessionUIStore.getState().addToInputHistory('second');
      const history = useSessionUIStore.getState().inputHistory;
      expect(history[0]).toBe('second');
      expect(history[1]).toBe('first');
    });

    it('should not add empty or whitespace-only input', () => {
      useSessionUIStore.getState().addToInputHistory('');
      useSessionUIStore.getState().addToInputHistory('   ');
      expect(useSessionUIStore.getState().inputHistory).toHaveLength(0);
    });

    it('should deduplicate consecutive identical inputs', () => {
      useSessionUIStore.getState().addToInputHistory('hello');
      useSessionUIStore.getState().addToInputHistory('hello');
      expect(useSessionUIStore.getState().inputHistory).toHaveLength(1);
    });

    it('should allow duplicate if not consecutive (most recent)', () => {
      useSessionUIStore.getState().addToInputHistory('hello');
      useSessionUIStore.getState().addToInputHistory('world');
      useSessionUIStore.getState().addToInputHistory('hello');
      expect(useSessionUIStore.getState().inputHistory).toHaveLength(3);
      expect(useSessionUIStore.getState().inputHistory[0]).toBe('hello');
    });

    it('should limit history to 100 entries', () => {
      for (let i = 0; i < 120; i++) {
        useSessionUIStore.getState().addToInputHistory(`msg-${i}`);
      }
      expect(useSessionUIStore.getState().inputHistory).toHaveLength(100);
      // Most recent should be msg-119
      expect(useSessionUIStore.getState().inputHistory[0]).toBe('msg-119');
    });

    it('should reset history index after adding', () => {
      useSessionUIStore.getState().addToInputHistory('first');
      // Simulate navigating to history
      useSessionUIStore.setState({ inputHistoryIndex: 0 });
      useSessionUIStore.getState().addToInputHistory('second');
      expect(useSessionUIStore.getState().inputHistoryIndex).toBe(-1);
    });
  });

  // ============================================================================
  // getPreviousInput
  // ============================================================================

  describe('getPreviousInput', () => {
    it('should return null when history is empty', () => {
      const result = useSessionUIStore.getState().getPreviousInput('current');
      expect(result).toBeNull();
    });

    it('should return first history item on first call', () => {
      useSessionUIStore.getState().addToInputHistory('older');
      useSessionUIStore.getState().addToInputHistory('newest');

      const result = useSessionUIStore.getState().getPreviousInput('draft');
      expect(result).toBe('newest');
    });

    it('should save current input as draft on first navigation', () => {
      useSessionUIStore.getState().addToInputHistory('history1');
      useSessionUIStore.getState().getPreviousInput('my draft');
      expect(useSessionUIStore.getState().inputHistoryDraft).toBe('my draft');
    });

    it('should navigate backwards through history', () => {
      useSessionUIStore.getState().addToInputHistory('first');
      useSessionUIStore.getState().addToInputHistory('second');
      useSessionUIStore.getState().addToInputHistory('third');

      expect(useSessionUIStore.getState().getPreviousInput('draft')).toBe('third');
      expect(useSessionUIStore.getState().getPreviousInput('draft')).toBe('second');
      expect(useSessionUIStore.getState().getPreviousInput('draft')).toBe('first');
    });

    it('should return null when at end of history', () => {
      useSessionUIStore.getState().addToInputHistory('only');
      useSessionUIStore.getState().getPreviousInput('draft');
      // Already at index 0, which is the last item
      expect(useSessionUIStore.getState().getPreviousInput('draft')).toBeNull();
    });
  });

  // ============================================================================
  // getNextInput
  // ============================================================================

  describe('getNextInput', () => {
    it('should return null when not navigating history', () => {
      expect(useSessionUIStore.getState().getNextInput()).toBeNull();
    });

    it('should navigate forward and return draft when back at start', () => {
      useSessionUIStore.getState().addToInputHistory('first');
      useSessionUIStore.getState().addToInputHistory('second');

      // Navigate back
      useSessionUIStore.getState().getPreviousInput('my draft');
      useSessionUIStore.getState().getPreviousInput('my draft');

      // Navigate forward
      const next = useSessionUIStore.getState().getNextInput();
      expect(next).toBe('second');

      // Back to draft
      const draft = useSessionUIStore.getState().getNextInput();
      expect(draft).toBe('my draft');
    });

    it('should return null when already at draft position', () => {
      useSessionUIStore.getState().addToInputHistory('item');
      useSessionUIStore.getState().getPreviousInput('draft');
      useSessionUIStore.getState().getNextInput(); // back to draft
      expect(useSessionUIStore.getState().getNextInput()).toBeNull();
    });
  });

  // ============================================================================
  // resetInputHistoryIndex
  // ============================================================================

  describe('resetInputHistoryIndex', () => {
    it('should reset index and draft', () => {
      useSessionUIStore.getState().addToInputHistory('item');
      useSessionUIStore.getState().getPreviousInput('some draft');

      useSessionUIStore.getState().resetInputHistoryIndex();
      expect(useSessionUIStore.getState().inputHistoryIndex).toBe(-1);
      expect(useSessionUIStore.getState().inputHistoryDraft).toBe('');
    });
  });

  // ============================================================================
  // filter
  // ============================================================================

  describe('setFilter', () => {
    it('should update filter value', () => {
      useSessionUIStore.getState().setFilter('archived');
      expect(useSessionUIStore.getState().filter).toBe('archived');
    });

    it('should accept all valid filter values', () => {
      for (const filter of ['active', 'archived', 'all'] as const) {
        useSessionUIStore.getState().setFilter(filter);
        expect(useSessionUIStore.getState().filter).toBe(filter);
      }
    });
  });

  describe('setSessionStatusFilter', () => {
    it('should default to all', () => {
      expect(useSessionUIStore.getState().sessionStatusFilter).toBe('all');
    });

    it('should update the local session status filter', () => {
      useSessionUIStore.getState().setSessionStatusFilter('background');
      expect(useSessionUIStore.getState().sessionStatusFilter).toBe('background');
    });
  });
});
