// ============================================================================
// File Read Tracker Tests [D2]
// ============================================================================
//
// Tests for the file read tracking module.
// The file read tracker should:
// - Record when files are read with their mtime
// - Check if a file has been read before
// - Detect if a file was modified externally after reading
// - Support clearing the tracking state
// ============================================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FileReadTracker,
  fileReadTracker,
  type FileReadRecord,
} from '../../../../src/main/tools/fileReadTracker';

describe('FileReadTracker', () => {
  let tracker: FileReadTracker;
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    // Get fresh instance for each test (use the singleton but clear it)
    tracker = fileReadTracker;
    tracker.clear();

    // Create temp directory and test file
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
    testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'initial content');
  });

  afterEach(() => {
    tracker.clear();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Recording Reads
  // --------------------------------------------------------------------------
  describe('Recording Reads', () => {
    it('should record file read with mtime and size', () => {
      const mtime = Date.now();
      const size = 100;
      tracker.recordRead('/path/to/file.ts', mtime, size);
      expect(tracker.hasBeenRead('/path/to/file.ts')).toBe(true);
    });

    it('should track multiple files independently', () => {
      tracker.recordRead('/file1.ts', 1000, 100);
      tracker.recordRead('/file2.ts', 2000, 200);
      expect(tracker.hasBeenRead('/file1.ts')).toBe(true);
      expect(tracker.hasBeenRead('/file2.ts')).toBe(true);
    });

    it('should update mtime on re-read', () => {
      tracker.recordRead('/file.ts', 1000, 100);
      tracker.recordRead('/file.ts', 2000, 150);

      const record = tracker.getReadRecord('/file.ts');
      expect(record?.mtime).toBe(2000);
      expect(record?.size).toBe(150);
    });

    it('should handle absolute paths', () => {
      tracker.recordRead('/Users/test/project/file.ts', Date.now(), 100);
      expect(tracker.hasBeenRead('/Users/test/project/file.ts')).toBe(true);
    });

    it('should store readTime when recording', () => {
      const before = Date.now();
      tracker.recordRead('/file.ts', 1000, 100);
      const after = Date.now();

      const record = tracker.getReadRecord('/file.ts');
      expect(record?.readTime).toBeGreaterThanOrEqual(before);
      expect(record?.readTime).toBeLessThanOrEqual(after);
    });

    it('should record read with stats automatically', async () => {
      await tracker.recordReadWithStats(testFile);
      expect(tracker.hasBeenRead(testFile)).toBe(true);

      const record = tracker.getReadRecord(testFile);
      expect(record).toBeDefined();
      expect(record?.mtime).toBeGreaterThan(0);
      expect(record?.size).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Checking Read Status
  // --------------------------------------------------------------------------
  describe('Checking Read Status', () => {
    it('should return false for unread files', () => {
      expect(tracker.hasBeenRead('/unread/file.ts')).toBe(false);
    });

    it('should return true for read files', () => {
      tracker.recordRead('/read/file.ts', Date.now(), 100);
      expect(tracker.hasBeenRead('/read/file.ts')).toBe(true);
    });

    it('should be case-sensitive on Unix', () => {
      tracker.recordRead('/File.ts', Date.now(), 100);
      expect(tracker.hasBeenRead('/file.ts')).toBe(false);
    });

    it('should return undefined for unread file record', () => {
      const record = tracker.getReadRecord('/unknown.ts');
      expect(record).toBeUndefined();
    });

    it('should return correct record for read file', () => {
      const mtime = 1234567890;
      const size = 500;
      tracker.recordRead('/file.ts', mtime, size);

      const record = tracker.getReadRecord('/file.ts');
      expect(record?.mtime).toBe(mtime);
      expect(record?.size).toBe(size);
    });
  });

  // --------------------------------------------------------------------------
  // External Modification Detection
  // --------------------------------------------------------------------------
  describe('External Modification Detection', () => {
    it('should detect external modification when mtime changes', () => {
      const originalMtime = 1000;
      tracker.recordRead('/file.ts', originalMtime, 100);
      const newMtime = 2000;
      expect(tracker.checkExternalModification('/file.ts', newMtime)).toBe(true);
    });

    it('should return false when mtime unchanged', () => {
      const mtime = 1000;
      tracker.recordRead('/file.ts', mtime, 100);
      expect(tracker.checkExternalModification('/file.ts', mtime)).toBe(false);
    });

    it('should allow 1ms tolerance for filesystem precision', () => {
      const mtime = 1000;
      tracker.recordRead('/file.ts', mtime, 100);
      // Within 1ms tolerance should be considered unchanged
      expect(tracker.checkExternalModification('/file.ts', mtime + 1)).toBe(false);
      expect(tracker.checkExternalModification('/file.ts', mtime - 1)).toBe(false);
      // Beyond 1ms tolerance should be detected as modified
      expect(tracker.checkExternalModification('/file.ts', mtime + 2)).toBe(true);
      expect(tracker.checkExternalModification('/file.ts', mtime - 2)).toBe(true);
    });

    it('should return false for files never read', () => {
      expect(tracker.checkExternalModification('/never/read.ts', 1000)).toBe(false);
    });

    it('should check external modification with stats', async () => {
      // Record the initial state
      const stats = fs.statSync(testFile);
      tracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // No modification yet
      const result1 = await tracker.checkExternalModificationWithStats(testFile);
      expect(result1.modified).toBe(false);

      // Simulate external modification
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'modified content by external process');

      // Should detect modification
      const result2 = await tracker.checkExternalModificationWithStats(testFile);
      expect(result2.modified).toBe(true);
      expect(result2.message).toContain('modified externally');
    });

    it('should return false for untracked file with stats check', async () => {
      const result = await tracker.checkExternalModificationWithStats('/unknown/file.ts');
      expect(result.modified).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Updating After Edit
  // --------------------------------------------------------------------------
  describe('Updating After Edit', () => {
    it('should update mtime after edit', () => {
      tracker.recordRead('/file.ts', 1000, 100);
      tracker.updateAfterEdit('/file.ts', 2000, 150);

      const record = tracker.getReadRecord('/file.ts');
      expect(record?.mtime).toBe(2000);
      expect(record?.size).toBe(150);
    });

    it('should not crash when updating untracked file', () => {
      expect(() => {
        tracker.updateAfterEdit('/unknown.ts', 2000, 150);
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Removing Tracking
  // --------------------------------------------------------------------------
  describe('Removing Tracking', () => {
    it('should remove tracking for a specific file', () => {
      tracker.recordRead('/file1.ts', 1000, 100);
      tracker.recordRead('/file2.ts', 2000, 200);
      tracker.removeTracking('/file1.ts');

      expect(tracker.hasBeenRead('/file1.ts')).toBe(false);
      expect(tracker.hasBeenRead('/file2.ts')).toBe(true);
    });

    it('should not crash when removing untracked file', () => {
      expect(() => {
        tracker.removeTracking('/unknown.ts');
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Clearing State
  // --------------------------------------------------------------------------
  describe('Clearing State', () => {
    it('should clear all tracked files', () => {
      tracker.recordRead('/file1.ts', 1000, 100);
      tracker.recordRead('/file2.ts', 2000, 200);
      tracker.clear();
      expect(tracker.hasBeenRead('/file1.ts')).toBe(false);
      expect(tracker.hasBeenRead('/file2.ts')).toBe(false);
    });

    it('should return empty array after clear', () => {
      tracker.recordRead('/file.ts', 1000, 100);
      tracker.clear();
      expect(tracker.getTrackedFiles()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------
  describe('Statistics', () => {
    it('should return correct total files count', () => {
      tracker.recordRead('/file1.ts', 1000, 100);
      tracker.recordRead('/file2.ts', 2000, 200);
      tracker.recordRead('/file3.ts', 3000, 300);

      const stats = tracker.getStats();
      expect(stats.totalFiles).toBe(3);
    });

    it('should return null for oldest read when empty', () => {
      const stats = tracker.getStats();
      expect(stats.totalFiles).toBe(0);
      expect(stats.oldestRead).toBeNull();
    });

    it('should return oldest read time', async () => {
      const time1 = Date.now();
      tracker.recordRead('/file1.ts', 1000, 100);
      await new Promise((resolve) => setTimeout(resolve, 10));
      tracker.recordRead('/file2.ts', 2000, 200);

      const stats = tracker.getStats();
      expect(stats.oldestRead).toBeLessThanOrEqual(time1 + 5);
    });

    it('should return tracked file paths', () => {
      tracker.recordRead('/path/a.ts', 1000, 100);
      tracker.recordRead('/path/b.ts', 2000, 200);

      const files = tracker.getTrackedFiles();
      expect(files).toContain('/path/a.ts');
      expect(files).toContain('/path/b.ts');
      expect(files).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton Pattern
  // --------------------------------------------------------------------------
  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = FileReadTracker.getInstance();
      const instance2 = FileReadTracker.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should share state between getInstance calls', () => {
      const instance1 = FileReadTracker.getInstance();
      instance1.recordRead('/shared.ts', 1000, 100);

      const instance2 = FileReadTracker.getInstance();
      expect(instance2.hasBeenRead('/shared.ts')).toBe(true);
    });

    it('should be the same as exported singleton', () => {
      expect(fileReadTracker).toBe(FileReadTracker.getInstance());
    });
  });
});
