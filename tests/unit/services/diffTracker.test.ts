// ============================================================================
// DiffTracker Tests [E3]
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DiffTracker,
  getDiffTracker,
  resetDiffTracker,
} from '../../../src/main/services/diff/diffTracker';

describe('DiffTracker', () => {
  let tracker: DiffTracker;

  beforeEach(() => {
    resetDiffTracker();
    tracker = new DiffTracker();
  });

  // --------------------------------------------------------------------------
  // computeAndStore
  // --------------------------------------------------------------------------
  describe('computeAndStore', () => {
    it('should compute diff for a simple change', () => {
      const diff = tracker.computeAndStore(
        'session-1',
        'msg-1',
        'tc-1',
        'src/app.ts',
        'const x = 1;\n',
        'const x = 2;\n'
      );

      expect(diff.filePath).toBe('src/app.ts');
      expect(diff.sessionId).toBe('session-1');
      expect(diff.stats.additions).toBeGreaterThan(0);
      expect(diff.stats.deletions).toBeGreaterThan(0);
      expect(diff.unifiedDiff).toContain('---');
      expect(diff.unifiedDiff).toContain('+++');
    });

    it('should handle new file creation (before is null)', () => {
      const diff = tracker.computeAndStore(
        'session-1',
        'msg-1',
        'tc-1',
        'src/new.ts',
        null,
        'const x = 1;\n'
      );

      expect(diff.before).toBeNull();
      expect(diff.after).toBe('const x = 1;\n');
      expect(diff.stats.additions).toBeGreaterThan(0);
      expect(diff.stats.deletions).toBe(0);
    });

    it('should handle file deletion (after is null)', () => {
      const diff = tracker.computeAndStore(
        'session-1',
        'msg-1',
        'tc-1',
        'src/old.ts',
        'const x = 1;\n',
        null
      );

      expect(diff.before).toBe('const x = 1;\n');
      expect(diff.after).toBeNull();
      expect(diff.stats.additions).toBe(0);
      expect(diff.stats.deletions).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const d1 = tracker.computeAndStore('s1', 'm1', 'tc1', 'a.ts', 'x', 'y');
      const d2 = tracker.computeAndStore('s1', 'm2', 'tc2', 'b.ts', 'x', 'y');
      expect(d1.id).not.toBe(d2.id);
    });
  });

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------
  describe('Queries', () => {
    beforeEach(() => {
      tracker.computeAndStore('s1', 'm1', 'tc1', 'a.ts', 'old', 'new');
      tracker.computeAndStore('s1', 'm1', 'tc2', 'b.ts', 'old', 'new');
      tracker.computeAndStore('s1', 'm2', 'tc3', 'c.ts', 'old', 'new');
      tracker.computeAndStore('s2', 'm3', 'tc4', 'd.ts', 'old', 'new');
    });

    it('getDiffsForSession should return correct count', () => {
      const diffs = tracker.getDiffsForSession('s1');
      expect(diffs).toHaveLength(3);
    });

    it('getDiffsForSession should not cross sessions', () => {
      const diffs = tracker.getDiffsForSession('s2');
      expect(diffs).toHaveLength(1);
    });

    it('getDiffsForMessage should filter by messageId', () => {
      const diffs = tracker.getDiffsForMessage('s1', 'm1');
      expect(diffs).toHaveLength(2);
    });

    it('getDiffsForFile should filter by filePath', () => {
      const diffs = tracker.getDiffsForFile('s1', 'a.ts');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].filePath).toBe('a.ts');
    });

    it('getSummary should aggregate stats', () => {
      const summary = tracker.getSummary('s1');
      expect(summary.filesChanged).toBe(3);
      expect(summary.totalAdditions).toBeGreaterThan(0);
      expect(summary.totalDeletions).toBeGreaterThan(0);
    });

    it('getSummary for empty session should return zeros', () => {
      const summary = tracker.getSummary('nonexistent');
      expect(summary.filesChanged).toBe(0);
      expect(summary.totalAdditions).toBe(0);
      expect(summary.totalDeletions).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Capacity Limit
  // --------------------------------------------------------------------------
  describe('Capacity', () => {
    it('should enforce max diffs per session', () => {
      // DiffTracker 默认上限 200 条
      for (let i = 0; i < 210; i++) {
        tracker.computeAndStore('s1', `m${i}`, `tc${i}`, `file${i}.ts`, 'a', 'b');
      }
      const diffs = tracker.getDiffsForSession('s1');
      expect(diffs.length).toBeLessThanOrEqual(200);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance', () => {
      const a = getDiffTracker();
      const b = getDiffTracker();
      expect(a).toBe(b);
    });

    it('should reset singleton', () => {
      const a = getDiffTracker();
      resetDiffTracker();
      const b = getDiffTracker();
      expect(a).not.toBe(b);
    });
  });
});
