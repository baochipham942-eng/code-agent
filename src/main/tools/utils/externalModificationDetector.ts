// ============================================================================
// External Modification Detector - Detect changes by external processes
// ============================================================================
// Provides utilities to detect if a file has been modified by external
// processes (IDE, user, other tools) since it was last read by the agent.
// This helps prevent accidental overwrites and data loss.
// ============================================================================

import fs from 'fs/promises';
import { fileReadTracker } from '../fileReadTracker';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ExternalModificationDetector');

export interface ModificationCheckResult {
  /** Whether the file was modified externally */
  modified: boolean;
  /** Human-readable message describing the result */
  message: string;
  /** Detailed information (only present when modified) */
  details?: {
    /** mtime when file was last read */
    readMtime: number;
    /** Current mtime of the file */
    currentMtime: number;
    /** Time elapsed since last read (ms) */
    timeSinceRead: number;
    /** File size when read */
    readSize: number;
    /** Current file size */
    currentSize: number;
  };
}

/**
 * Check if a file was modified externally since it was last read
 *
 * @param filePath - Absolute path to the file
 * @returns Result indicating if file was modified
 */
export async function checkExternalModification(
  filePath: string
): Promise<ModificationCheckResult> {
  const record = fileReadTracker.getReadRecord(filePath);

  // If file was never read, we can't detect external modification
  if (!record) {
    return {
      modified: false,
      message: 'File was not previously read in this session',
    };
  }

  try {
    const stats = await fs.stat(filePath);
    const currentMtime = stats.mtimeMs;
    const currentSize = stats.size;

    // Check mtime difference (allow 1ms tolerance for filesystem precision)
    const mtimeChanged = Math.abs(currentMtime - record.mtime) > 1;
    // Check size difference
    const sizeChanged = currentSize !== record.size;

    if (mtimeChanged || sizeChanged) {
      const timeSinceRead = Date.now() - record.readTime;

      logger.warn('External modification detected', {
        filePath,
        mtimeChanged,
        sizeChanged,
        readMtime: record.mtime,
        currentMtime,
        readSize: record.size,
        currentSize,
      });

      return {
        modified: true,
        message: buildModificationMessage(
          mtimeChanged,
          sizeChanged,
          timeSinceRead
        ),
        details: {
          readMtime: record.mtime,
          currentMtime,
          timeSinceRead,
          readSize: record.size,
          currentSize,
        },
      };
    }

    return {
      modified: false,
      message: 'File has not been modified since last read',
    };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        modified: true,
        message: 'File was deleted since last read',
      };
    }

    logger.error('Error checking external modification', { filePath, error });
    return {
      modified: false,
      message: `Unable to check modification status: ${error.message}`,
    };
  }
}

/**
 * Build a human-readable modification message
 */
function buildModificationMessage(
  mtimeChanged: boolean,
  sizeChanged: boolean,
  timeSinceReadMs: number
): string {
  const parts: string[] = [];

  if (mtimeChanged && sizeChanged) {
    parts.push('File was modified externally (content and timestamp changed)');
  } else if (mtimeChanged) {
    parts.push('File was modified externally (timestamp changed)');
  } else if (sizeChanged) {
    parts.push('File size changed');
  }

  // Add time context
  const seconds = Math.round(timeSinceReadMs / 1000);
  if (seconds < 60) {
    parts.push(`(changed within ${seconds}s of last read)`);
  } else if (seconds < 3600) {
    parts.push(`(changed within ${Math.round(seconds / 60)}min of last read)`);
  }

  return parts.join(' ');
}

/**
 * Check if a file is safe to edit (has been read and not modified externally)
 *
 * @param filePath - Absolute path to the file
 * @returns Object with safety status and reason
 */
export async function isFileSafeToEdit(
  filePath: string
): Promise<{
  safe: boolean;
  reason: string;
  warningLevel: 'none' | 'info' | 'warning' | 'error';
}> {
  // Check if file has been read
  if (!fileReadTracker.hasBeenRead(filePath)) {
    return {
      safe: false,
      reason: 'File must be read before editing. Use read_file first.',
      warningLevel: 'error',
    };
  }

  // Check for external modifications
  const modCheck = await checkExternalModification(filePath);

  if (modCheck.modified) {
    return {
      safe: false,
      reason: modCheck.message,
      warningLevel: 'warning',
    };
  }

  return {
    safe: true,
    reason: 'File is safe to edit',
    warningLevel: 'none',
  };
}

/**
 * Get modification status for multiple files
 *
 * @param filePaths - Array of absolute file paths
 * @returns Map of file paths to their modification status
 */
export async function checkMultipleFiles(
  filePaths: string[]
): Promise<Map<string, ModificationCheckResult>> {
  const results = new Map<string, ModificationCheckResult>();

  await Promise.all(
    filePaths.map(async (filePath) => {
      const result = await checkExternalModification(filePath);
      results.set(filePath, result);
    })
  );

  return results;
}

/**
 * Watch for external modifications (useful for long-running sessions)
 * Returns a cleanup function to stop watching
 *
 * @param filePath - File to watch
 * @param onModification - Callback when modification detected
 * @param intervalMs - Check interval in milliseconds (default: 5000)
 * @returns Cleanup function
 */
export function watchForModifications(
  filePath: string,
  onModification: (result: ModificationCheckResult) => void,
  intervalMs: number = 5000
): () => void {
  const interval = setInterval(async () => {
    const result = await checkExternalModification(filePath);
    if (result.modified) {
      onModification(result);
    }
  }, intervalMs);

  return () => clearInterval(interval);
}

/**
 * Format modification details for user display
 *
 * @param result - Modification check result
 * @returns Formatted string for display
 */
export function formatModificationWarning(
  result: ModificationCheckResult
): string {
  if (!result.modified || !result.details) {
    return result.message;
  }

  const { readMtime, currentMtime, readSize, currentSize, timeSinceRead } =
    result.details;

  const lines = [
    '⚠️  External modification detected!',
    '',
    `Read at: ${new Date(readMtime).toISOString()}`,
    `Modified at: ${new Date(currentMtime).toISOString()}`,
    `Time since read: ${Math.round(timeSinceRead / 1000)}s`,
    '',
  ];

  if (readSize !== currentSize) {
    const diff = currentSize - readSize;
    const sign = diff > 0 ? '+' : '';
    lines.push(`Size change: ${readSize} → ${currentSize} (${sign}${diff} bytes)`);
  }

  lines.push(
    '',
    'Options:',
    '1. Re-read the file to see current content',
    '2. Proceed with edit (may overwrite external changes)',
    '3. Cancel the operation'
  );

  return lines.join('\n');
}
