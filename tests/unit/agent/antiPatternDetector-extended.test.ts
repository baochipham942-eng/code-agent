// ============================================================================
// AntiPatternDetector Extended Tests
// Covers trackToolExecution, trackToolFailure, trackDuplicateCall,
// detectReadOnlyStopPattern, clearToolFailure, and state management
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock logCollector
vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: {
    addLog: vi.fn(),
    agent: vi.fn(),
  },
}));

import { AntiPatternDetector, TOOL_ALTERNATIVES } from '../../../src/main/agent/antiPattern/detector';

describe('AntiPatternDetector - Extended', () => {
  let detector: AntiPatternDetector;

  beforeEach(() => {
    detector = new AntiPatternDetector();
  });

  // --------------------------------------------------------------------------
  // trackToolExecution - Read/Write tracking
  // --------------------------------------------------------------------------
  describe('trackToolExecution', () => {
    it('should return null for initial read operations', () => {
      const result = detector.trackToolExecution('read_file', true);
      expect(result).toBeNull();
    });

    it('should return null for write operations (resets counter)', () => {
      // Do some reads first
      detector.trackToolExecution('read_file', true);
      detector.trackToolExecution('glob', true);
      // Write resets
      const result = detector.trackToolExecution('write_file', true);
      expect(result).toBeNull();
      expect(detector.getConsecutiveReadCount()).toBe(0);
      expect(detector.hasWritten()).toBe(true);
    });

    it('should warn after maxConsecutiveReadsBeforeWrite (default 5)', () => {
      for (let i = 0; i < 4; i++) {
        expect(detector.trackToolExecution('read_file', true)).toBeNull();
      }
      const warning = detector.trackToolExecution('read_file', true);
      expect(warning).not.toBeNull();
      expect(warning).toContain('critical-warning');
      expect(warning).toContain('CREATION task');
    });

    it('should warn after maxConsecutiveReadsAfterWrite (default 10)', () => {
      // First write
      detector.trackToolExecution('write_file', true);
      // Then reads
      for (let i = 0; i < 9; i++) {
        expect(detector.trackToolExecution('read_file', true)).toBeNull();
      }
      const warning = detector.trackToolExecution('read_file', true);
      expect(warning).not.toBeNull();
      expect(warning).toContain('ALREADY created');
    });

    it('should return HARD_LIMIT after maxConsecutiveReadsHardLimit (default 15)', () => {
      for (let i = 0; i < 14; i++) {
        detector.trackToolExecution('read_file', true);
      }
      const result = detector.trackToolExecution('glob', true);
      expect(result).toBe('HARD_LIMIT');
    });

    it('should not count failed write operations as writes', () => {
      detector.trackToolExecution('write_file', false);
      expect(detector.hasWritten()).toBe(false);
    });

    it('should track various read tools', () => {
      const readTools = ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'];
      for (const tool of readTools) {
        detector.trackToolExecution(tool, true);
      }
      expect(detector.getConsecutiveReadCount()).toBe(5);
    });

    it('should not count unrecognized tools as reads or writes', () => {
      detector.trackToolExecution('custom_tool', true);
      expect(detector.getConsecutiveReadCount()).toBe(0);
      expect(detector.hasWritten()).toBe(false);
    });

    it('should respect custom config thresholds', () => {
      const customDetector = new AntiPatternDetector({
        maxConsecutiveReadsBeforeWrite: 2,
      });
      customDetector.trackToolExecution('read_file', true);
      const warning = customDetector.trackToolExecution('read_file', true);
      expect(warning).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // trackToolFailure - 4-level escalation
  // --------------------------------------------------------------------------
  describe('trackToolFailure', () => {
    const makeToolCall = (name: string, args: Record<string, unknown> = {}) => ({
      id: 'test-id',
      name,
      arguments: args,
    });

    it('should return strike-1 guidance on first failure', () => {
      const result = detector.trackToolFailure(
        makeToolCall('edit_file', { file_path: '/test.ts' }),
        'old_string not found'
      );
      expect(result).toContain('strike-1-guidance');
      expect(result).toContain('verify');
    });

    it('should suggest alternative on second failure (strike 2)', () => {
      const toolCall = makeToolCall('edit_file', { file_path: '/test.ts' });
      detector.trackToolFailure(toolCall, 'old_string not found');
      const result = detector.trackToolFailure(
        makeToolCall('edit_file', { file_path: '/test2.ts' }),
        'different error'
      );
      expect(result).toContain('strategy-switch-suggestion');
      expect(result).toContain('write_file');
    });

    it('should force alternative on third failure (strike 3) when alternative exists', () => {
      const toolCall1 = makeToolCall('edit_file', { file_path: '/a.ts' });
      const toolCall2 = makeToolCall('edit_file', { file_path: '/b.ts' });
      const toolCall3 = makeToolCall('edit_file', { file_path: '/c.ts' });
      detector.trackToolFailure(toolCall1, 'error 1');
      detector.trackToolFailure(toolCall2, 'error 2');
      const result = detector.trackToolFailure(toolCall3, 'error 3');
      expect(result).toContain('force-alternative');
      expect(result).toContain('write_file');
    });

    it('should inject rethink directive on third failure (strike 3) when no alternative', () => {
      const toolCall1 = makeToolCall('unknown_tool', { param: '1' });
      const toolCall2 = makeToolCall('unknown_tool', { param: '2' });
      const toolCall3 = makeToolCall('unknown_tool', { param: '3' });
      detector.trackToolFailure(toolCall1, 'error 1');
      detector.trackToolFailure(toolCall2, 'error 2');
      const result = detector.trackToolFailure(toolCall3, 'error 3');
      expect(result).toContain('strike-3-rethink');
      expect(result).toContain('STOP and rethink');
    });

    it('should escalate to user on fourth failure (strike 4+)', () => {
      for (let i = 0; i < 3; i++) {
        detector.trackToolFailure(
          makeToolCall('edit_file', { file_path: `/file${i}.ts` }),
          `error ${i}`
        );
      }
      const result = detector.trackToolFailure(
        makeToolCall('edit_file', { file_path: '/file4.ts' }),
        'error 4'
      );
      expect(result).toBe('ESCALATE_TO_USER');
    });

    it('should track repeated same-args failures (tool-name escalation takes priority)', () => {
      const sameToolCall = makeToolCall('edit_file', { file_path: '/same.ts', old_string: 'x' });
      detector.trackToolFailure(sameToolCall, 'same error');
      detector.trackToolFailure(sameToolCall, 'same error');
      const result = detector.trackToolFailure(sameToolCall, 'same error');
      // On 3rd call: exact-args hits maxSameToolFailures=3 AND tool-name hits strike 3
      // edit_file has alternative, so strike 3 returns force-alternative (higher priority)
      expect(result).toContain('force-alternative');
    });

    it('should clear failure tracker on success', () => {
      const toolCall = makeToolCall('edit_file', { file_path: '/test.ts' });
      detector.trackToolFailure(toolCall, 'error');
      detector.clearToolFailure(toolCall);

      // Next failure should be strike 1 again
      // But note: tool name tracker may persist if a different instance
      // This tests the exact-args tracker reset
      const state = detector.getState();
      const key = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
      expect(state.toolFailureTracker.has(key)).toBe(false);
    });

    it('should handle tools without alternatives gracefully', () => {
      const toolCall = makeToolCall('custom_tool', { param: 'value' });
      detector.trackToolFailure(toolCall, 'error 1');
      const result = detector.trackToolFailure(
        makeToolCall('custom_tool', { param: 'value2' }),
        'error 2'
      );
      // No alternative for custom_tool, should not contain strategy-switch
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // trackDuplicateCall
  // --------------------------------------------------------------------------
  describe('trackDuplicateCall', () => {
    const makeToolCall = (name: string, args: Record<string, unknown> = {}) => ({
      id: 'test-id',
      name,
      arguments: args,
    });

    it('should return null on first call', () => {
      const result = detector.trackDuplicateCall(
        makeToolCall('read_file', { file_path: '/test.ts' })
      );
      expect(result).toBeNull();
    });

    it('should return cache hint on second identical read call', () => {
      const call = makeToolCall('read_file', { file_path: '/test.ts' });
      detector.trackDuplicateCall(call);
      const result = detector.trackDuplicateCall(call);
      expect(result).toContain('cache-hint');
      expect(result).toContain('already available');
    });

    it('should return duplicate warning on third identical call', () => {
      const call = makeToolCall('read_file', { file_path: '/test.ts' });
      detector.trackDuplicateCall(call);
      detector.trackDuplicateCall(call);
      const result = detector.trackDuplicateCall(call);
      expect(result).toContain('duplicate-call-warning');
      expect(result).toContain('infinite loop');
    });

    it('should not flag different arguments as duplicates', () => {
      detector.trackDuplicateCall(makeToolCall('read_file', { file_path: '/a.ts' }));
      detector.trackDuplicateCall(makeToolCall('read_file', { file_path: '/b.ts' }));
      const result = detector.trackDuplicateCall(
        makeToolCall('read_file', { file_path: '/c.ts' })
      );
      expect(result).toBeNull();
    });

    it('should not give cache hint for non-read tools on second call', () => {
      const call = makeToolCall('bash', { command: 'ls' });
      detector.trackDuplicateCall(call);
      const result = detector.trackDuplicateCall(call);
      // bash is not in READ_ONLY_TOOLS, so no cache hint on 2nd call
      expect(result).toBeNull();
    });

    it('should give warning for non-read tools on maxDuplicateCalls', () => {
      const call = makeToolCall('bash', { command: 'echo hi' });
      detector.trackDuplicateCall(call);
      detector.trackDuplicateCall(call);
      const result = detector.trackDuplicateCall(call);
      expect(result).toContain('duplicate-call-warning');
    });
  });

  // --------------------------------------------------------------------------
  // detectReadOnlyStopPattern
  // --------------------------------------------------------------------------
  describe('detectReadOnlyStopPattern', () => {
    it('should detect read-only pattern (has reads, no writes)', () => {
      const result = detector.detectReadOnlyStopPattern(['read_file', 'glob', 'grep']);
      expect(result).not.toBeNull();
      expect(result).toContain('execution-nudge');
    });

    it('should return null when writes are present', () => {
      const result = detector.detectReadOnlyStopPattern(['read_file', 'edit_file']);
      expect(result).toBeNull();
    });

    it('should return null when no read tools used', () => {
      const result = detector.detectReadOnlyStopPattern(['bash', 'custom_tool']);
      expect(result).toBeNull();
    });

    it('should return null for empty tool list', () => {
      const result = detector.detectReadOnlyStopPattern([]);
      expect(result).toBeNull();
    });

    it('should escalate urgency for 3+ reads', () => {
      const result = detector.detectReadOnlyStopPattern([
        'read_file', 'glob', 'grep',
      ]);
      expect(result).toContain('priority="critical"');
      expect(result).toContain('立即执行修改');
    });

    it('should use normal tone for 1-2 reads', () => {
      const result = detector.detectReadOnlyStopPattern(['read_file']);
      expect(result).not.toBeNull();
      expect(result).not.toContain('priority="critical"');
    });
  });

  // --------------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------------
  describe('state management', () => {
    it('should reset all state', () => {
      detector.trackToolExecution('read_file', true);
      detector.trackToolExecution('write_file', true);
      detector.trackDuplicateCall({
        id: 'x', name: 'read_file', arguments: { file_path: '/a' },
      });

      detector.reset();

      expect(detector.getConsecutiveReadCount()).toBe(0);
      expect(detector.hasWritten()).toBe(false);
      const state = detector.getState();
      expect(state.toolFailureTracker.size).toBe(0);
      expect(state.duplicateCallTracker.size).toBe(0);
    });

    it('should return readonly state copy', () => {
      const state1 = detector.getState();
      const state2 = detector.getState();
      // Should be different object references
      expect(state1).not.toBe(state2);
      expect(state1.toolFailureTracker).not.toBe(state2.toolFailureTracker);
    });

    it('generateHardLimitError should include read count', () => {
      for (let i = 0; i < 5; i++) {
        detector.trackToolExecution('read_file', true);
      }
      const error = detector.generateHardLimitError();
      expect(error).toContain('5');
      expect(error).toContain('中止');
    });

    it('generateToolCallFormatError should include tool name', () => {
      const error = detector.generateToolCallFormatError('bash', 'Ran: ls -la');
      expect(error).toContain('bash');
      expect(error).toContain('tool-call-format-error');
    });
  });

  // --------------------------------------------------------------------------
  // TOOL_ALTERNATIVES
  // --------------------------------------------------------------------------
  describe('TOOL_ALTERNATIVES', () => {
    it('should have alternatives for edit_file', () => {
      expect(TOOL_ALTERNATIVES.edit_file).toBeDefined();
      expect(TOOL_ALTERNATIVES.edit_file.alternative).toBe('write_file');
    });

    it('should have alternatives for read_file', () => {
      expect(TOOL_ALTERNATIVES.read_file).toBeDefined();
      expect(TOOL_ALTERNATIVES.read_file.alternative).toBe('bash');
    });

    it('should have alternatives for glob', () => {
      expect(TOOL_ALTERNATIVES.glob).toBeDefined();
    });

    it('should have alternatives for grep', () => {
      expect(TOOL_ALTERNATIVES.grep).toBeDefined();
    });

    it('should have alternatives for web_fetch', () => {
      expect(TOOL_ALTERNATIVES.web_fetch).toBeDefined();
    });
  });
});
