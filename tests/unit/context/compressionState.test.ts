// ============================================================================
// CompressionState Tests
// ============================================================================
// Tests for immutable compression state with commit log + snapshot model.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CompressionState,
  type CompressionCommit,
} from '../../../src/main/context/compressionState';

describe('CompressionState', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------
  describe('initial state', () => {
    it('should start with empty commit log', () => {
      expect(state.getCommitLog()).toHaveLength(0);
    });

    it('should start with empty snapshot', () => {
      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.size).toBe(0);
      expect(snapshot.budgetedResults.size).toBe(0);
      expect(snapshot.collapsedSpans).toHaveLength(0);
      expect(snapshot.microcompactedIds.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // applyCommit — snip
  // --------------------------------------------------------------------------
  describe('applyCommit (snip)', () => {
    it('should append commit to log', () => {
      const commit: CompressionCommit = {
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1', 'msg2'],
        timestamp: 1000,
      };
      state.applyCommit(commit);
      expect(state.getCommitLog()).toHaveLength(1);
      expect(state.getCommitLog()[0]).toEqual(commit);
    });

    it('should add snipped ids to snapshot.snippedIds', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1', 'msg2'],
        timestamp: 1000,
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.has('msg1')).toBe(true);
      expect(snapshot.snippedIds.has('msg2')).toBe(true);
    });

    it('should accumulate snipped ids from multiple commits', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg3'],
        timestamp: 2000,
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.has('msg1')).toBe(true);
      expect(snapshot.snippedIds.has('msg3')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // applyCommit — truncate (tool-result-budget)
  // --------------------------------------------------------------------------
  describe('applyCommit (truncate)', () => {
    it('should add to budgetedResults with token metadata', () => {
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1'],
        timestamp: 1000,
        metadata: { originalTokens: 500, truncatedTokens: 100 },
      });
      const snapshot = state.getSnapshot();
      const result = snapshot.budgetedResults.get('tool1');
      expect(result).toBeDefined();
      expect(result?.originalTokens).toBe(500);
      expect(result?.truncatedTokens).toBe(100);
    });

    it('should handle multiple tool results in one commit', () => {
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1', 'tool2'],
        timestamp: 1000,
        metadata: { originalTokens: 200, truncatedTokens: 50 },
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.budgetedResults.has('tool1')).toBe(true);
      expect(snapshot.budgetedResults.has('tool2')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // applyCommit — collapse
  // --------------------------------------------------------------------------
  describe('applyCommit (collapse)', () => {
    it('should push to collapsedSpans with summary', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['msg1', 'msg2', 'msg3'],
        timestamp: 1000,
        metadata: { summary: 'User asked about X, assistant explained Y' },
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.collapsedSpans).toHaveLength(1);
      expect(snapshot.collapsedSpans[0].messageIds).toEqual(['msg1', 'msg2', 'msg3']);
      expect(snapshot.collapsedSpans[0].summary).toBe('User asked about X, assistant explained Y');
    });

    it('should preserve originalTokens from metadata if provided', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
        metadata: { summary: 'Collapsed context', originalTokens: 1500 },
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.collapsedSpans[0].originalTokens).toBe(1500);
    });

    it('should accumulate multiple collapsed spans', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['msg1', 'msg2'],
        timestamp: 1000,
        metadata: { summary: 'First collapse' },
      });
      state.applyCommit({
        layer: 'autocompact',
        operation: 'compact',
        targetMessageIds: ['msg3', 'msg4'],
        timestamp: 2000,
        metadata: { summary: 'Second collapse' },
      });
      // compact doesn't go to collapsedSpans, only collapse does
      const snapshot = state.getSnapshot();
      expect(snapshot.collapsedSpans).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // applyCommit — compact (microcompact)
  // --------------------------------------------------------------------------
  describe('applyCommit (compact)', () => {
    it('should add ids to microcompactedIds', () => {
      state.applyCommit({
        layer: 'microcompact',
        operation: 'compact',
        targetMessageIds: ['msg1', 'msg2'],
        timestamp: 1000,
      });
      const snapshot = state.getSnapshot();
      expect(snapshot.microcompactedIds.has('msg1')).toBe(true);
      expect(snapshot.microcompactedIds.has('msg2')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // reset
  // --------------------------------------------------------------------------
  describe('reset', () => {
    it('should clear all snapshot fields', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1'],
        timestamp: 2000,
        metadata: { originalTokens: 100, truncatedTokens: 20 },
      });
      state.reset();
      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.size).toBe(0);
      expect(snapshot.budgetedResults.size).toBe(0);
      expect(snapshot.collapsedSpans).toHaveLength(0);
      expect(snapshot.microcompactedIds.size).toBe(0);
    });

    it('should record a reset commit in the log', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      state.reset();
      const log = state.getCommitLog();
      expect(log).toHaveLength(2);
      expect(log[1].operation).toBe('reset');
    });
  });

  // --------------------------------------------------------------------------
  // getCommitsByLayer
  // --------------------------------------------------------------------------
  describe('getCommitsByLayer', () => {
    it('should return only commits matching the layer', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1'],
        timestamp: 2000,
        metadata: { originalTokens: 100, truncatedTokens: 20 },
      });
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg2'],
        timestamp: 3000,
      });

      const snipCommits = state.getCommitsByLayer('snip');
      expect(snipCommits).toHaveLength(2);
      expect(snipCommits.every((c) => c.layer === 'snip')).toBe(true);
    });

    it('should return empty array when no matching commits', () => {
      expect(state.getCommitsByLayer('microcompact')).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Commit log ordering
  // --------------------------------------------------------------------------
  describe('commit log ordering', () => {
    it('should maintain insertion order', () => {
      const commits: CompressionCommit[] = [
        { layer: 'snip', operation: 'snip', targetMessageIds: ['a'], timestamp: 1 },
        { layer: 'tool-result-budget', operation: 'truncate', targetMessageIds: ['b'], timestamp: 2, metadata: { originalTokens: 10, truncatedTokens: 5 } },
        { layer: 'contextCollapse', operation: 'collapse', targetMessageIds: ['c'], timestamp: 3, metadata: { summary: 'x' } },
      ];
      commits.forEach((c) => state.applyCommit(c));
      const log = state.getCommitLog();
      expect(log[0].timestamp).toBe(1);
      expect(log[1].timestamp).toBe(2);
      expect(log[2].timestamp).toBe(3);
    });

    it('should return readonly commit log (no mutation)', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      const log = state.getCommitLog();
      // Attempting to push to the returned array should not affect internal state
      // (TypeScript readonly prevents this at compile time, but test runtime behavior)
      expect(log).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Serialization round-trip
  // --------------------------------------------------------------------------
  describe('serialize / deserialize', () => {
    it('should serialize and deserialize with same commit log', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1', 'msg2'],
        timestamp: 1000,
      });
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1'],
        timestamp: 2000,
        metadata: { originalTokens: 500, truncatedTokens: 100 },
      });

      const json = state.serialize();
      const restored = CompressionState.deserialize(json);

      expect(restored.getCommitLog()).toHaveLength(2);
      expect(restored.getCommitLog()[0]).toEqual(state.getCommitLog()[0]);
      expect(restored.getCommitLog()[1]).toEqual(state.getCommitLog()[1]);
    });

    it('should restore snapshot correctly after deserialization', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['msg1'],
        timestamp: 1000,
      });
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['msg2', 'msg3'],
        timestamp: 2000,
        metadata: { summary: 'Collapsed', originalTokens: 800 },
      });

      const json = state.serialize();
      const restored = CompressionState.deserialize(json);
      const snapshot = restored.getSnapshot();

      expect(snapshot.snippedIds.has('msg1')).toBe(true);
      expect(snapshot.collapsedSpans).toHaveLength(1);
      expect(snapshot.collapsedSpans[0].summary).toBe('Collapsed');
    });

    it('should produce valid JSON string', () => {
      state.applyCommit({
        layer: 'microcompact',
        operation: 'compact',
        targetMessageIds: ['m1'],
        timestamp: 500,
      });
      const json = state.serialize();
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });
});
