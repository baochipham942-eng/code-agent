// ============================================================================
// statusStore.test.ts - Agent 运行状态 store 测试
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { useStatusStore } from '../../../src/renderer/stores/statusStore';

describe('statusStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useStatusStore.setState({
      inputTokens: 0,
      outputTokens: 0,
      sessionCost: 0,
      contextUsagePercent: 0,
      sessionStartTime: Date.now(),
      networkStatus: 'online',
      gitBranch: null,
      workingDirectory: null,
      gitChanges: null,
      isStreaming: false,
    });
  });

  // ============================================================================
  // Initial state
  // ============================================================================

  it('should have correct initial state', () => {
    const state = useStatusStore.getState();
    expect(state.inputTokens).toBe(0);
    expect(state.outputTokens).toBe(0);
    expect(state.sessionCost).toBe(0);
    expect(state.contextUsagePercent).toBe(0);
    expect(state.networkStatus).toBe('online');
    expect(state.gitBranch).toBeNull();
    expect(state.workingDirectory).toBeNull();
    expect(state.gitChanges).toBeNull();
    expect(state.isStreaming).toBe(false);
  });

  // ============================================================================
  // updateTokens
  // ============================================================================

  describe('updateTokens', () => {
    it('should accumulate input and output tokens', () => {
      const { updateTokens } = useStatusStore.getState();
      updateTokens(100, 50);
      expect(useStatusStore.getState().inputTokens).toBe(100);
      expect(useStatusStore.getState().outputTokens).toBe(50);
    });

    it('should accumulate across multiple calls', () => {
      const { updateTokens } = useStatusStore.getState();
      updateTokens(100, 50);
      updateTokens(200, 100);
      expect(useStatusStore.getState().inputTokens).toBe(300);
      expect(useStatusStore.getState().outputTokens).toBe(150);
    });

    it('should handle zero values', () => {
      const { updateTokens } = useStatusStore.getState();
      updateTokens(0, 0);
      expect(useStatusStore.getState().inputTokens).toBe(0);
      expect(useStatusStore.getState().outputTokens).toBe(0);
    });
  });

  // ============================================================================
  // addCost
  // ============================================================================

  describe('addCost', () => {
    it('should accumulate session cost', () => {
      const { addCost } = useStatusStore.getState();
      addCost(0.005);
      addCost(0.003);
      expect(useStatusStore.getState().sessionCost).toBeCloseTo(0.008);
    });
  });

  // ============================================================================
  // resetSession
  // ============================================================================

  describe('resetSession', () => {
    it('should reset tokens, cost, and context usage', () => {
      const state = useStatusStore.getState();
      state.updateTokens(500, 300);
      state.addCost(0.01);
      state.setContextUsage(75);

      state.resetSession();

      const newState = useStatusStore.getState();
      expect(newState.inputTokens).toBe(0);
      expect(newState.outputTokens).toBe(0);
      expect(newState.sessionCost).toBe(0);
      expect(newState.contextUsagePercent).toBe(0);
    });

    it('should update sessionStartTime', () => {
      const before = Date.now();
      useStatusStore.getState().resetSession();
      const after = Date.now();
      const { sessionStartTime } = useStatusStore.getState();
      expect(sessionStartTime).toBeGreaterThanOrEqual(before);
      expect(sessionStartTime).toBeLessThanOrEqual(after);
    });
  });

  // ============================================================================
  // setContextUsage
  // ============================================================================

  describe('setContextUsage', () => {
    it('should set context usage percent', () => {
      useStatusStore.getState().setContextUsage(85);
      expect(useStatusStore.getState().contextUsagePercent).toBe(85);
    });
  });

  // ============================================================================
  // setNetworkStatus
  // ============================================================================

  describe('setNetworkStatus', () => {
    it('should update network status', () => {
      useStatusStore.getState().setNetworkStatus('offline');
      expect(useStatusStore.getState().networkStatus).toBe('offline');
    });

    it('should accept all valid statuses', () => {
      for (const status of ['online', 'offline', 'slow'] as const) {
        useStatusStore.getState().setNetworkStatus(status);
        expect(useStatusStore.getState().networkStatus).toBe(status);
      }
    });
  });

  // ============================================================================
  // setGitInfo
  // ============================================================================

  describe('setGitInfo', () => {
    it('should set git branch and working directory', () => {
      useStatusStore.getState().setGitInfo('main', '/home/user/project');
      expect(useStatusStore.getState().gitBranch).toBe('main');
      expect(useStatusStore.getState().workingDirectory).toBe('/home/user/project');
    });

    it('should handle null values', () => {
      useStatusStore.getState().setGitInfo('main', '/path');
      useStatusStore.getState().setGitInfo(null, null);
      expect(useStatusStore.getState().gitBranch).toBeNull();
      expect(useStatusStore.getState().workingDirectory).toBeNull();
    });
  });

  // ============================================================================
  // setGitChanges
  // ============================================================================

  describe('setGitChanges', () => {
    it('should set git changes', () => {
      const changes = { staged: 2, unstaged: 3, untracked: 1 };
      useStatusStore.getState().setGitChanges(changes);
      expect(useStatusStore.getState().gitChanges).toEqual(changes);
    });

    it('should handle null', () => {
      useStatusStore.getState().setGitChanges({ staged: 1, unstaged: 0, untracked: 0 });
      useStatusStore.getState().setGitChanges(null);
      expect(useStatusStore.getState().gitChanges).toBeNull();
    });
  });

  // ============================================================================
  // setStreaming
  // ============================================================================

  describe('setStreaming', () => {
    it('should set streaming state', () => {
      useStatusStore.getState().setStreaming(true);
      expect(useStatusStore.getState().isStreaming).toBe(true);

      useStatusStore.getState().setStreaming(false);
      expect(useStatusStore.getState().isStreaming).toBe(false);
    });
  });
});
