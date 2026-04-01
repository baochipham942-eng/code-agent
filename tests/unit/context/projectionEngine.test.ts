// ============================================================================
// ProjectionEngine Tests
// ============================================================================
// Tests for pure projection of transcript through compression state.
// The original transcript is NEVER modified; projectionEngine generates the
// API view at query time.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionEngine, type ProjectableMessage } from '../../../src/main/context/projectionEngine';
import { CompressionState } from '../../../src/main/context/compressionState';

function makeMsg(id: string, role: string, content: string): ProjectableMessage {
  return { id, role, content };
}

describe('ProjectionEngine', () => {
  let engine: ProjectionEngine;
  let state: CompressionState;

  beforeEach(() => {
    engine = new ProjectionEngine();
    state = new CompressionState();
  });

  // --------------------------------------------------------------------------
  // No compression — pass-through
  // --------------------------------------------------------------------------
  describe('no compression', () => {
    it('should return transcript unchanged when state is empty', () => {
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Hello'),
        makeMsg('m2', 'assistant', 'World'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(transcript[0]);
      expect(result[1]).toEqual(transcript[1]);
    });

    it('should return empty array for empty transcript', () => {
      const result = engine.projectMessages([], state);
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Snipped messages
  // --------------------------------------------------------------------------
  describe('snipped messages', () => {
    it('should replace snipped message content with placeholder', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['m2'],
        timestamp: 1000,
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'First'),
        makeMsg('m2', 'assistant', 'Long response that was snipped'),
        makeMsg('m3', 'user', 'Next'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result).toHaveLength(3);
      expect(result[1].content).toBe('[snipped: message compressed]');
      expect(result[1].id).toBe('m2');
    });

    it('should not affect non-snipped messages', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['m2'],
        timestamp: 1000,
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'First'),
        makeMsg('m2', 'assistant', 'Snipped'),
        makeMsg('m3', 'user', 'Keep this'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result[0].content).toBe('First');
      expect(result[2].content).toBe('Keep this');
    });

    it('should replace multiple snipped messages', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['m1', 'm3'],
        timestamp: 1000,
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Snip me'),
        makeMsg('m2', 'assistant', 'Keep me'),
        makeMsg('m3', 'user', 'Snip me too'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result[0].content).toBe('[snipped: message compressed]');
      expect(result[1].content).toBe('Keep me');
      expect(result[2].content).toBe('[snipped: message compressed]');
    });
  });

  // --------------------------------------------------------------------------
  // Collapsed spans
  // --------------------------------------------------------------------------
  describe('collapsed spans', () => {
    it('should replace first message of span with summary and remove the rest', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['m2', 'm3', 'm4'],
        timestamp: 1000,
        metadata: { summary: 'User asked about context, assistant explained compression' },
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Before'),
        makeMsg('m2', 'user', 'Start of span'),
        makeMsg('m3', 'assistant', 'Middle of span'),
        makeMsg('m4', 'user', 'End of span'),
        makeMsg('m5', 'assistant', 'After'),
      ];
      const result = engine.projectMessages(transcript, state);

      // m1, summary (m2 slot), m5 — total 3 messages
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('m1');
      expect(result[1].id).toBe('m2');
      expect(result[1].role).toBe('system');
      expect(result[1].content).toBe('[collapsed: 3 turns] User asked about context, assistant explained compression');
      expect(result[2].id).toBe('m5');
    });

    it('should handle single-message collapsed span', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['m1'],
        timestamp: 1000,
        metadata: { summary: 'Just one message collapsed' },
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Only message'),
        makeMsg('m2', 'assistant', 'Response'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('[collapsed: 1 turns] Just one message collapsed');
      expect(result[0].role).toBe('system');
      expect(result[1].content).toBe('Response');
    });

    it('should handle multiple non-overlapping collapsed spans', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['m1', 'm2'],
        timestamp: 1000,
        metadata: { summary: 'First block' },
      });
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['m4', 'm5'],
        timestamp: 2000,
        metadata: { summary: 'Second block' },
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'A'),
        makeMsg('m2', 'assistant', 'B'),
        makeMsg('m3', 'user', 'Middle'),
        makeMsg('m4', 'assistant', 'C'),
        makeMsg('m5', 'user', 'D'),
      ];
      const result = engine.projectMessages(transcript, state);
      // m1(summary), m3(kept), m4(summary) = 3
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('[collapsed: 2 turns] First block');
      expect(result[1].content).toBe('Middle');
      expect(result[2].content).toBe('[collapsed: 2 turns] Second block');
    });
  });

  // --------------------------------------------------------------------------
  // Budget pass-through
  // --------------------------------------------------------------------------
  describe('budgeted results (pass-through)', () => {
    it('should pass budgeted messages through unchanged (truncation already applied)', () => {
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool1'],
        timestamp: 1000,
        metadata: { originalTokens: 500, truncatedTokens: 100 },
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Run tool'),
        makeMsg('tool1', 'tool', 'Truncated tool result'),
      ];
      const result = engine.projectMessages(transcript, state);
      expect(result).toHaveLength(2);
      expect(result[1].content).toBe('Truncated tool result');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple layers applied together
  // --------------------------------------------------------------------------
  describe('multiple layers combined', () => {
    it('should apply collapse then snip correctly', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['m2', 'm3'],
        timestamp: 1000,
        metadata: { summary: 'Old context' },
      });
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['m5'],
        timestamp: 2000,
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Start'),
        makeMsg('m2', 'user', 'Span A'),
        makeMsg('m3', 'assistant', 'Span B'),
        makeMsg('m4', 'user', 'Keep'),
        makeMsg('m5', 'assistant', 'Snip me'),
        makeMsg('m6', 'user', 'End'),
      ];
      const result = engine.projectMessages(transcript, state);
      // m1, m2(summary), m4, m5(snipped), m6 = 5
      expect(result).toHaveLength(5);
      expect(result[0].content).toBe('Start');
      expect(result[1].content).toBe('[collapsed: 2 turns] Old context');
      expect(result[2].content).toBe('Keep');
      expect(result[3].content).toBe('[snipped: message compressed]');
      expect(result[4].content).toBe('End');
    });

    it('should not mutate the original transcript', () => {
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['m1'],
        timestamp: 1000,
      });
      const transcript: ProjectableMessage[] = [
        makeMsg('m1', 'user', 'Original content'),
      ];
      engine.projectMessages(transcript, state);
      // Original must remain unchanged
      expect(transcript[0].content).toBe('Original content');
    });
  });
});
