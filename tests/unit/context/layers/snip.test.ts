// ============================================================================
// L2: Snip Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { applySnip } from '../../../../src/main/context/layers/snip';
import { CompressionState } from '../../../../src/main/context/compressionState';

type SnipMessage = { id: string; role: string; content: string; turnIndex: number };

function makeMsg(id: string, role: string, content: string, turnIndex: number): SnipMessage {
  return { id, role, content, turnIndex };
}

describe('applySnip', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  // --------------------------------------------------------------------------
  // Basic eligibility
  // --------------------------------------------------------------------------
  describe('message eligibility', () => {
    it('should snip old assistant messages', () => {
      const msgs = [
        makeMsg('a1', 'assistant', 'Some response', 0),
        makeMsg('a2', 'assistant', 'Another response', 1),
        makeMsg('u1', 'user', 'Recent question', 10),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.has('a1')).toBe(true);
      expect(snapshot.snippedIds.has('a2')).toBe(true);
      expect(snapshot.snippedIds.has('u1')).toBe(false);
    });

    it('should never snip user messages', () => {
      const msgs = [
        makeMsg('u1', 'user', 'Old question from user', 0),
        makeMsg('u2', 'user', 'Another old question', 1),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.has('u1')).toBe(false);
      expect(snapshot.snippedIds.has('u2')).toBe(false);
    });

    it('should never snip system messages', () => {
      const msgs = [
        makeMsg('s1', 'system', 'You are an assistant', 0),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      expect(state.getSnapshot().snippedIds.has('s1')).toBe(false);
    });

    it('should never snip messages with code blocks', () => {
      const contentWithCode = 'Here is the solution:\n```python\nprint("hello")\n```\nEnd.';
      const msgs = [
        makeMsg('a1', 'assistant', contentWithCode, 0),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      expect(state.getSnapshot().snippedIds.has('a1')).toBe(false);
    });

    it('should not snip messages with inline code blocks', () => {
      const content = 'Use ```bash\necho hello\n``` to run it.';
      const msgs = [makeMsg('a1', 'assistant', content, 0)];
      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });
      expect(state.getSnapshot().snippedIds.has('a1')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Recent turn preservation
  // --------------------------------------------------------------------------
  describe('recent turn preservation', () => {
    it('should not snip messages within preserveRecentTurns', () => {
      const msgs = [
        makeMsg('a1', 'assistant', 'Old', 3),
        makeMsg('a2', 'assistant', 'Recent', 7),
        makeMsg('a3', 'assistant', 'Very recent', 9),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      // cutoff = 10 - 5 = 5; turnIndex >= 5 is preserved
      const snapshot = state.getSnapshot();
      expect(snapshot.snippedIds.has('a1')).toBe(true); // turnIndex 3 < 5
      expect(snapshot.snippedIds.has('a2')).toBe(false); // turnIndex 7 >= 5
      expect(snapshot.snippedIds.has('a3')).toBe(false); // turnIndex 9 >= 5
    });

    it('should preserve all messages when currentTurnIndex is small', () => {
      const msgs = [
        makeMsg('a1', 'assistant', 'Response', 0),
        makeMsg('a2', 'assistant', 'Response 2', 1),
      ];

      applySnip(msgs, state, { currentTurnIndex: 3, preserveRecentTurns: 5 });

      // cutoff = 3 - 5 = -2; all messages have turnIndex >= -2
      expect(state.getSnapshot().snippedIds.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Already-snipped messages
  // --------------------------------------------------------------------------
  describe('already-snipped messages', () => {
    it('should skip messages that are already snipped', () => {
      // Pre-snip a1
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['a1'],
        timestamp: 1000,
      });

      const msgs = [
        makeMsg('a1', 'assistant', 'Previously snipped', 0),
        makeMsg('a2', 'assistant', 'New candidate', 1),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      const commits = state.getCommitLog();
      // Should have original pre-snip commit + one new commit for a2
      const snipCommits = commits.filter((c) => c.layer === 'snip');
      const allSnipped = snipCommits.flatMap((c) => c.targetMessageIds);
      // a1 should not appear again in a new snip commit
      expect(allSnipped.filter((id) => id === 'a1')).toHaveLength(1); // only from pre-commit
      expect(allSnipped).toContain('a2');
    });
  });

  // --------------------------------------------------------------------------
  // Commit structure
  // --------------------------------------------------------------------------
  describe('commit structure', () => {
    it('should write a single commit containing all snipped IDs', () => {
      const msgs = [
        makeMsg('a1', 'assistant', 'Response 1', 0),
        makeMsg('a2', 'assistant', 'Response 2', 1),
        makeMsg('a3', 'assistant', 'Response 3', 2),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      const commits = state.getCommitLog();
      expect(commits).toHaveLength(1);
      expect(commits[0].layer).toBe('snip');
      expect(commits[0].operation).toBe('snip');
      expect(commits[0].targetMessageIds).toEqual(['a1', 'a2', 'a3']);
    });

    it('should write no commit when no messages are eligible', () => {
      const msgs = [
        makeMsg('u1', 'user', 'Question', 0),
        makeMsg('a1', 'assistant', 'Recent response', 9),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      expect(state.getCommitLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Tool messages
  // --------------------------------------------------------------------------
  describe('tool messages', () => {
    it('should snip old tool messages (role=tool)', () => {
      const msgs = [
        makeMsg('t1', 'tool', 'Tool output from long ago', 0),
      ];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      expect(state.getSnapshot().snippedIds.has('t1')).toBe(true);
    });

    it('should not snip tool messages with code blocks', () => {
      const content = '```json\n{"result": true}\n```';
      const msgs = [makeMsg('t1', 'tool', content, 0)];
      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });
      expect(state.getSnapshot().snippedIds.has('t1')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // No mutation of original messages
  // --------------------------------------------------------------------------
  describe('no mutation', () => {
    it('should not mutate the original message content', () => {
      const content = 'Original assistant response';
      const msgs = [makeMsg('a1', 'assistant', content, 0)];

      applySnip(msgs, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });

      expect(msgs[0].content).toBe(content);
    });
  });
});
