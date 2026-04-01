// ============================================================================
// Token Optimizer - Observation Mask Tests (Sprint 3 Performance Optimization)
// ============================================================================
// Tests the optimized observationMask function:
// - Messages with '[output cleared' are skipped (returned as-is)
// - Messages with '[cleared]' are skipped
// - Messages with '[Observation masked' are skipped
// - Normal messages are processed (masked when eligible)
// - Null/empty content is handled
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing the module under test
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  observationMask,
  type CompressedMessage,
  type ObservationMaskConfig,
} from '../../../src/main/context/tokenOptimizer';
import { OBSERVATION_MASKING } from '../../../src/shared/constants/agent';

// Helper: create a tool message with given content
function toolMsg(content: string, id?: string): CompressedMessage {
  return { role: 'tool', content, id: id ?? `tool-${Math.random().toString(36).slice(2)}` };
}

// Helper: create a user message
function userMsg(content: string): CompressedMessage {
  return { role: 'user', content };
}

// Helper: create an assistant message
function assistantMsg(content: string): CompressedMessage {
  return { role: 'assistant', content };
}

// Helper: build a long tool output that exceeds the default threshold (100 tokens)
// With BPE tokenization, we need ~8 repetitions to reliably exceed 100 tokens
function longToolOutput(prefix: string = 'Result'): string {
  return `${prefix}: ${'This is a substantial tool output that contains enough text to exceed the minimum token threshold. '.repeat(8)}`;
}

describe('observationMask', () => {
  // --------------------------------------------------------------------------
  // Already-masked messages are skipped (Sprint 3 optimization)
  // --------------------------------------------------------------------------
  describe('skip already-masked messages', () => {
    it('should skip messages containing "[output cleared"', () => {
      const messages: CompressedMessage[] = [
        toolMsg('[output cleared - tool was executed successfully]'),
        toolMsg(longToolOutput()),
        userMsg('What happened?'),
        assistantMsg('Let me check.'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 2 });

      // First message (already masked) should be returned as-is
      expect(result.messages[0].content).toBe('[output cleared - tool was executed successfully]');
      // Second tool message (old, long) should be masked
      expect(result.maskedCount).toBe(1);
    });

    it('should skip messages with "[cleared]"', () => {
      const messages: CompressedMessage[] = [
        toolMsg('[cleared]'),
        toolMsg(longToolOutput()),
        userMsg('test'),
        assistantMsg('reply'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 2 });

      expect(result.messages[0].content).toBe('[cleared]');
      // Only the second tool message should be processed
      expect(result.maskedCount).toBe(1);
    });

    it('should skip messages starting with "[Observation masked"', () => {
      const messages: CompressedMessage[] = [
        toolMsg('[Observation masked - previous tool result removed]'),
        toolMsg(longToolOutput()),
        userMsg('test'),
        assistantMsg('reply'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 2 });

      expect(result.messages[0].content).toBe('[Observation masked - previous tool result removed]');
      expect(result.maskedCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Normal messages are processed
  // --------------------------------------------------------------------------
  describe('normal message processing', () => {
    it('should mask old tool messages that exceed token threshold', () => {
      const messages: CompressedMessage[] = [
        toolMsg(longToolOutput('First tool')),
        toolMsg(longToolOutput('Second tool')),
        userMsg('Recent user message'),
        assistantMsg('Recent assistant reply'),
        userMsg('Latest message'),
        assistantMsg('Latest reply'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 4 });

      // First two tool messages are old (index < length - 4)
      expect(result.maskedCount).toBe(2);
      expect(result.savedTokens).toBeGreaterThan(0);
    });

    it('should not mask non-tool messages', () => {
      const messages: CompressedMessage[] = [
        userMsg('Old user message with lots of content'),
        assistantMsg('Old assistant message with lots of content'),
        toolMsg(longToolOutput()),
        userMsg('Recent'),
        assistantMsg('Recent'),
        userMsg('Latest'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 3 });

      // Only the tool message should be eligible for masking
      expect(result.maskedCount).toBe(1);
      // User and assistant messages should be untouched
      expect(result.messages[0].content).toBe('Old user message with lots of content');
      expect(result.messages[1].content).toBe('Old assistant message with lots of content');
    });

    it('should preserve recent messages (within preserveRecentCount)', () => {
      const recentToolContent = longToolOutput('Recent tool');
      const messages: CompressedMessage[] = [
        toolMsg(longToolOutput('Old tool')),
        userMsg('middle'),
        assistantMsg('middle'),
        toolMsg(recentToolContent),   // This is within preserveRecentCount
        userMsg('latest'),
        assistantMsg('latest'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 3 });

      // Recent tool message (index 3, within last 3) should not be masked
      expect(result.messages[3].content).toBe(recentToolContent);
      // Old tool message should be masked
      expect(result.maskedCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Null/empty content handling
  // --------------------------------------------------------------------------
  describe('null and empty content', () => {
    it('should skip messages with empty content', () => {
      const messages: CompressedMessage[] = [
        toolMsg(''),
        toolMsg(longToolOutput()),
        userMsg('test'),
        assistantMsg('reply'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 2 });

      // Empty content should be skipped (returned as-is)
      expect(result.messages[0].content).toBe('');
      // Only the second tool message should be processed
      expect(result.maskedCount).toBe(1);
    });

    it('should skip messages with null-like content', () => {
      const messages: CompressedMessage[] = [
        { role: 'tool', content: null as unknown as string },
        toolMsg(longToolOutput()),
        userMsg('test'),
        assistantMsg('reply'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 2 });

      // Null content should be skipped
      expect(result.messages[0].content).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Token threshold
  // --------------------------------------------------------------------------
  describe('token threshold', () => {
    it('should not mask tool messages below token threshold', () => {
      const shortContent = 'OK';
      const messages: CompressedMessage[] = [
        toolMsg(shortContent),
        userMsg('test'),
        assistantMsg('reply'),
        userMsg('latest'),
        assistantMsg('latest'),
        userMsg('newest'),
      ];

      const result = observationMask(messages, {
        preserveRecentCount: 3,
        minTokenThreshold: 100,
      });

      // Short tool message should not be masked
      expect(result.messages[0].content).toBe(shortContent);
      expect(result.maskedCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Placeholder selection (success vs error)
  // --------------------------------------------------------------------------
  describe('placeholder selection', () => {
    it('should use error placeholder for error content', () => {
      const errorContent = longToolOutput() + ' Error: something failed';
      const messages: CompressedMessage[] = [
        toolMsg(errorContent),
        userMsg('test'),
        assistantMsg('reply'),
        userMsg('latest'),
        assistantMsg('latest'),
        userMsg('newest'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 3 });

      expect(result.messages[0].content).toBe(OBSERVATION_MASKING.PLACEHOLDER_ERROR);
      expect(result.maskedCount).toBe(1);
    });

    it('should use success placeholder for normal content', () => {
      const normalContent = longToolOutput();
      const messages: CompressedMessage[] = [
        toolMsg(normalContent),
        userMsg('test'),
        assistantMsg('reply'),
        userMsg('latest'),
        assistantMsg('latest'),
        userMsg('newest'),
      ];

      const result = observationMask(messages, { preserveRecentCount: 3 });

      expect(result.messages[0].content).toBe(OBSERVATION_MASKING.PLACEHOLDER_SUCCESS);
      expect(result.maskedCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Config defaults
  // --------------------------------------------------------------------------
  describe('config defaults', () => {
    it('should use OBSERVATION_MASKING constants as defaults', () => {
      // Build a message array with enough messages
      const messages: CompressedMessage[] = [];
      // Add old tool message
      messages.push(toolMsg(longToolOutput()));
      // Add preserveRecentCount + 1 more messages to ensure old ones are outside boundary
      for (let i = 0; i < OBSERVATION_MASKING.PRESERVE_RECENT_COUNT + 1; i++) {
        messages.push(userMsg(`msg ${i}`));
      }

      const result = observationMask(messages);

      // Should use default preserveRecentCount from constants
      expect(result.maskedCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Empty messages array
  // --------------------------------------------------------------------------
  describe('empty input', () => {
    it('should handle empty messages array', () => {
      const result = observationMask([]);
      expect(result.messages).toEqual([]);
      expect(result.maskedCount).toBe(0);
      expect(result.savedTokens).toBe(0);
    });
  });
});
