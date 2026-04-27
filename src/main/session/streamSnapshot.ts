// ============================================================================
// Stream Snapshot Persistence
//
// Periodically saves streaming state to disk during model inference.
// Enables mid-stream crash recovery: if the process dies while receiving
// a response, the partial content can be restored on next startup.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { CONFIG_DIR_NEW } from '../config/configPaths';
import type { StreamSnapshot } from '../model/providers/sseStream';

const logger = createLogger('StreamSnapshot');

const SNAPSHOT_FILE = 'stream-snapshot.json';

interface PersistedSnapshot extends StreamSnapshot {
  sessionId: string;
  turnId: string;
  streamStatus: 'incomplete' | 'complete';
  stableForExecution: boolean;
  incompleteToolCallIds: string[];
}

/**
 * Get the snapshot file path for the current working directory
 */
function getSnapshotPath(workingDir?: string): string {
  const base = workingDir || process.cwd();
  return path.join(base, CONFIG_DIR_NEW, SNAPSHOT_FILE);
}

export function getIncompleteToolCallIds(snapshot: Pick<StreamSnapshot, 'toolCalls' | 'isFinal'>): string[] {
  if (snapshot.isFinal) {
    return [];
  }
  const incompleteIds: string[] = [];
  for (const toolCall of snapshot.toolCalls || []) {
    if (!toolCall.name || !toolCall.arguments) {
      incompleteIds.push(toolCall.id);
      continue;
    }
    try {
      JSON.parse(toolCall.arguments);
    } catch {
      incompleteIds.push(toolCall.id);
    }
  }
  return incompleteIds;
}

/**
 * Save a stream snapshot to disk (atomic write)
 */
export function saveStreamSnapshot(
  snapshot: StreamSnapshot,
  sessionId: string,
  turnId: string,
  workingDir?: string,
): void {
  try {
    const filePath = getSnapshotPath(workingDir);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const incompleteToolCallIds = getIncompleteToolCallIds(snapshot);
    const data: PersistedSnapshot = {
      ...snapshot,
      sessionId,
      turnId,
      streamStatus: snapshot.isFinal ? 'complete' : 'incomplete',
      stableForExecution: snapshot.isFinal && incompleteToolCallIds.length === 0,
      incompleteToolCallIds,
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Non-fatal: snapshot is a best-effort optimization
    logger.debug(`Failed to save stream snapshot: ${message}`);
  }
}

/**
 * Load a pending stream snapshot (from a previous crashed session)
 * Returns null if no snapshot exists or if it's already finalized.
 */
export function loadStreamSnapshot(workingDir?: string): PersistedSnapshot | null {
  try {
    const filePath = getSnapshotPath(workingDir);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: PersistedSnapshot = JSON.parse(raw);

    // If the snapshot was finalized, the stream completed normally - no recovery needed
    if (data.isFinal) {
      clearStreamSnapshot(workingDir);
      return null;
    }

    logger.info('Found incomplete stream snapshot', {
      sessionId: data.sessionId,
      contentLength: data.content.length,
      toolCallCount: data.toolCalls.length,
      incompleteToolCallIds: data.incompleteToolCallIds ?? getIncompleteToolCallIds(data),
      timestamp: new Date(data.timestamp).toISOString(),
    });

    const incompleteToolCallIds = getIncompleteToolCallIds(data);
    return {
      ...data,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to load stream snapshot: ${message}`);
    return null;
  }
}

/**
 * Clear the stream snapshot file (called after successful completion or recovery)
 */
export function clearStreamSnapshot(workingDir?: string): void {
  try {
    const filePath = getSnapshotPath(workingDir);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    // Also clean up stale tmp file
    const tmpPath = filePath + '.tmp';
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a snapshot handler bound to a specific session/turn.
 * Returns a callback suitable for passing to SSEStreamOptions.onSnapshot.
 */
export function createSnapshotHandler(
  sessionId: string,
  turnId: string,
  workingDir?: string,
): (snapshot: StreamSnapshot) => void {
  return (snapshot: StreamSnapshot) => {
    saveStreamSnapshot(snapshot, sessionId, turnId, workingDir);
    if (snapshot.isFinal) {
      // Final snapshot means stream completed normally - clean up
      clearStreamSnapshot(workingDir);
    }
  };
}
