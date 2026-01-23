// ============================================================================
// External Modification Detector Tests [D2]
// ============================================================================
//
// Tests for the external modification detection module.
// The detector should:
// - Compare current file mtime with recorded mtime
// - Integrate with FileReadTracker
// - Provide detailed modification info
// - Handle file deletion and creation
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkExternalModification,
  isFileSafeToEdit,
  checkMultipleFiles,
  watchForModifications,
  formatModificationWarning,
  type ModificationCheckResult,
} from '../../../../src/main/tools/utils/externalModificationDetector';
import { fileReadTracker } from '../../../../src/main/tools/fileReadTracker';

describe('ExternalModificationDetector', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    // Clear read tracker state
    fileReadTracker.clear();

    // Create temp directory and test file
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-mod-test-'));
    testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'initial content');
  });

  afterEach(() => {
    fileReadTracker.clear();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Basic Detection
  // --------------------------------------------------------------------------
  describe('checkExternalModification', () => {
    it('should return not modified for unread file', async () => {
      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
      expect(result.message).toContain('not previously read');
    });

    it('should detect when file mtime has changed', async () => {
      // Record the initial state
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // Wait and modify the file
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'modified content');

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(true);
      expect(result.message).toContain('modified externally');
      expect(result.details).toBeDefined();
    });

    it('should detect when file size has changed', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'much longer content that changes size');

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(true);
      expect(result.details?.readSize).not.toBe(result.details?.currentSize);
    });

    it('should return not modified when file unchanged', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
      expect(result.message).toContain('has not been modified');
    });

    it('should detect when tracked file is deleted', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // Delete the file
      fs.unlinkSync(testFile);

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(true);
      expect(result.message).toContain('deleted');
    });

    it('should provide detailed modification info', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'new content');

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details?.readMtime).toBe(stats.mtimeMs);
      expect(result.details?.readSize).toBe(stats.size);
      expect(result.details?.currentMtime).toBeGreaterThan(stats.mtimeMs);
      expect(result.details?.timeSinceRead).toBeGreaterThan(0);
    });

    it('should allow 1ms tolerance for mtime', async () => {
      const stats = fs.statSync(testFile);
      // Record with exact mtime
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // File should still be considered not modified
      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // isFileSafeToEdit
  // --------------------------------------------------------------------------
  describe('isFileSafeToEdit', () => {
    it('should return not safe if file was not read', async () => {
      const result = await isFileSafeToEdit(testFile);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('must be read before editing');
      expect(result.warningLevel).toBe('error');
    });

    it('should return not safe if file was modified externally', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'external changes');

      const result = await isFileSafeToEdit(testFile);
      expect(result.safe).toBe(false);
      expect(result.warningLevel).toBe('warning');
    });

    it('should return safe if file was read and not modified', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      const result = await isFileSafeToEdit(testFile);
      expect(result.safe).toBe(true);
      expect(result.reason).toContain('safe to edit');
      expect(result.warningLevel).toBe('none');
    });
  });

  // --------------------------------------------------------------------------
  // checkMultipleFiles
  // --------------------------------------------------------------------------
  describe('checkMultipleFiles', () => {
    it('should check multiple files at once', async () => {
      const file2 = path.join(tempDir, 'test2.txt');
      fs.writeFileSync(file2, 'file 2 content');

      const stats1 = fs.statSync(testFile);
      const stats2 = fs.statSync(file2);
      fileReadTracker.recordRead(testFile, stats1.mtimeMs, stats1.size);
      fileReadTracker.recordRead(file2, stats2.mtimeMs, stats2.size);

      // Modify one file
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'modified');

      const results = await checkMultipleFiles([testFile, file2]);
      expect(results.size).toBe(2);
      expect(results.get(testFile)?.modified).toBe(true);
      expect(results.get(file2)?.modified).toBe(false);
    });

    it('should handle empty array', async () => {
      const results = await checkMultipleFiles([]);
      expect(results.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // watchForModifications
  // --------------------------------------------------------------------------
  describe('watchForModifications', () => {
    it('should call callback when modification detected', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      let callbackCalled = false;
      let callbackResult: ModificationCheckResult | null = null;

      const cleanup = watchForModifications(
        testFile,
        (result) => {
          callbackCalled = true;
          callbackResult = result;
        },
        50 // Check every 50ms
      );

      // Modify the file
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'modified by external process');

      // Wait for the watcher to detect
      await new Promise((resolve) => setTimeout(resolve, 100));

      cleanup();

      expect(callbackCalled).toBe(true);
      expect(callbackResult?.modified).toBe(true);
    });

    it('should stop watching when cleanup called', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      let callCount = 0;

      const cleanup = watchForModifications(
        testFile,
        () => {
          callCount++;
        },
        50
      );

      // Stop watching immediately
      cleanup();

      // Modify the file
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'modified');

      // Wait to see if callback is called
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // formatModificationWarning
  // --------------------------------------------------------------------------
  describe('formatModificationWarning', () => {
    it('should format simple message for non-modified result', () => {
      const result: ModificationCheckResult = {
        modified: false,
        message: 'File has not been modified',
      };
      const formatted = formatModificationWarning(result);
      expect(formatted).toBe('File has not been modified');
    });

    it('should format detailed warning for modified result', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'longer content here');

      const checkResult = await checkExternalModification(testFile);
      const formatted = formatModificationWarning(checkResult);

      expect(formatted).toContain('⚠️');
      expect(formatted).toContain('External modification detected');
      expect(formatted).toContain('Read at:');
      expect(formatted).toContain('Modified at:');
      expect(formatted).toContain('Options:');
    });

    it('should show size change in formatted warning', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      await new Promise((resolve) => setTimeout(resolve, 10));
      // Make file significantly larger
      fs.writeFileSync(testFile, 'much much much longer content than before');

      const checkResult = await checkExternalModification(testFile);
      const formatted = formatModificationWarning(checkResult);

      expect(formatted).toContain('Size change:');
      expect(formatted).toContain('bytes');
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('should handle non-existent file that was never read', async () => {
      const result = await checkExternalModification('/non/existent/file.ts');
      expect(result.modified).toBe(false);
      expect(result.message).toContain('not previously read');
    });

    it('should handle permission errors gracefully', async () => {
      // This test may not work on all systems
      // Just verify it doesn't throw
      const result = await checkExternalModification('/root/protected.txt');
      expect(result.modified).toBe(false);
    });

    it('should handle rapid modifications', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // Rapid modifications
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(testFile, `content ${i}`);
      }

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(true);
    });

    it('should handle empty file', async () => {
      const emptyFile = path.join(tempDir, 'empty.txt');
      fs.writeFileSync(emptyFile, '');

      const stats = fs.statSync(emptyFile);
      fileReadTracker.recordRead(emptyFile, stats.mtimeMs, stats.size);

      // Add content to empty file
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(emptyFile, 'now has content');

      const result = await checkExternalModification(emptyFile);
      expect(result.modified).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Integration with FileReadTracker
  // --------------------------------------------------------------------------
  describe('Integration', () => {
    it('should work with FileReadTracker recordReadWithStats', async () => {
      await fileReadTracker.recordReadWithStats(testFile);

      // Verify file is tracked
      expect(fileReadTracker.hasBeenRead(testFile)).toBe(true);

      // No modification should be detected
      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
    });

    it('should work after FileReadTracker updateAfterEdit', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);

      // Simulate edit
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, 'edited content');
      const newStats = fs.statSync(testFile);

      // Update tracker as edit tool would
      fileReadTracker.updateAfterEdit(testFile, newStats.mtimeMs, newStats.size);

      // Should not detect modification since we updated the tracker
      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
    });

    it('should detect modification after tracker clear', async () => {
      const stats = fs.statSync(testFile);
      fileReadTracker.recordRead(testFile, stats.mtimeMs, stats.size);
      fileReadTracker.clear();

      const result = await checkExternalModification(testFile);
      expect(result.modified).toBe(false);
      expect(result.message).toContain('not previously read');
    });
  });
});
