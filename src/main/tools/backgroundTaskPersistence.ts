// ============================================================================
// Background Task Persistence - Persist and recover background tasks
// ============================================================================
// Saves information about running background tasks to disk, enabling
// recovery after process restart. Tasks are stored in ~/.code-agent/tasks/
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('BackgroundTaskPersistence');

// Task storage directory
const TASKS_DIR = path.join(os.homedir(), '.code-agent', 'tasks');

/**
 * Status of a background task
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'orphaned';

/**
 * Persisted background task information
 */
export interface BackgroundTask {
  /** Unique task ID */
  taskId: string;
  /** The command being executed */
  command: string;
  /** Working directory for the command */
  workingDirectory: string;
  /** When the task started */
  startTime: number;
  /** Process ID (if known) */
  pid?: number;
  /** Path to the output log file */
  outputFile: string;
  /** Current status */
  status: BackgroundTaskStatus;
  /** Exit code (if completed) */
  exitCode?: number;
  /** Error message (if failed) */
  error?: string;
  /** When the task completed */
  endTime?: number;
  /** Associated session ID */
  sessionId?: string;
  /** Task description/label */
  description?: string;
}

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().split('-')[0];
  return `task_${timestamp}_${random}`;
}

/**
 * Ensure the tasks directory exists
 */
async function ensureTasksDir(): Promise<void> {
  await fs.mkdir(TASKS_DIR, { recursive: true });
}

/**
 * Get the path to a task's metadata file
 */
function getTaskMetadataPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

/**
 * Get the path to a task's output log file
 */
export function getTaskOutputPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.log`);
}

/**
 * Create a new background task record
 *
 * @param command - The command being executed
 * @param workingDirectory - Working directory for the command
 * @param options - Additional options
 * @returns The created task
 */
export async function createTask(
  command: string,
  workingDirectory: string,
  options: {
    sessionId?: string;
    description?: string;
    pid?: number;
  } = {}
): Promise<BackgroundTask> {
  await ensureTasksDir();

  const taskId = generateTaskId();
  const outputFile = getTaskOutputPath(taskId);

  const task: BackgroundTask = {
    taskId,
    command,
    workingDirectory,
    startTime: Date.now(),
    outputFile,
    status: 'running',
    pid: options.pid,
    sessionId: options.sessionId,
    description: options.description,
  };

  await saveTask(task);

  // Create empty output file
  await fs.writeFile(outputFile, '', 'utf-8');

  logger.info('Created background task', { taskId, command });

  return task;
}

/**
 * Save a task to disk
 */
async function saveTask(task: BackgroundTask): Promise<void> {
  await ensureTasksDir();
  const metadataPath = getTaskMetadataPath(task.taskId);
  await fs.writeFile(metadataPath, JSON.stringify(task, null, 2), 'utf-8');
}

/**
 * Load a task from disk
 *
 * @param taskId - The task ID to load
 * @returns The task or null if not found
 */
export async function loadTask(taskId: string): Promise<BackgroundTask | null> {
  try {
    const metadataPath = getTaskMetadataPath(taskId);
    const content = await fs.readFile(metadataPath, 'utf-8');
    try {
      return JSON.parse(content) as BackgroundTask;
    } catch (parseError) {
      logger.error('Failed to parse task JSON', { taskId, parseError });
      return null;
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null;
    }
    logger.error('Error loading task', { taskId, error });
    throw error;
  }
}

/**
 * Update a task's status
 *
 * @param taskId - The task ID
 * @param status - New status
 * @param additionalFields - Additional fields to update
 */
export async function updateTaskStatus(
  taskId: string,
  status: BackgroundTaskStatus,
  additionalFields: Partial<BackgroundTask> = {}
): Promise<void> {
  const task = await loadTask(taskId);
  if (!task) {
    logger.warn('Task not found for status update', { taskId });
    return;
  }

  task.status = status;
  Object.assign(task, additionalFields);

  if (status === 'completed' || status === 'failed') {
    task.endTime = Date.now();
  }

  await saveTask(task);
  logger.debug('Updated task status', { taskId, status });
}

/**
 * Mark a task as completed
 */
export async function completeTask(
  taskId: string,
  exitCode: number
): Promise<void> {
  await updateTaskStatus(taskId, exitCode === 0 ? 'completed' : 'failed', {
    exitCode,
  });
}

/**
 * Mark a task as failed
 */
export async function failTask(taskId: string, error: string): Promise<void> {
  await updateTaskStatus(taskId, 'failed', { error });
}

/**
 * Append output to a task's log file
 *
 * @param taskId - The task ID
 * @param output - Output to append
 */
export async function appendTaskOutput(
  taskId: string,
  output: string
): Promise<void> {
  const outputPath = getTaskOutputPath(taskId);
  await fs.appendFile(outputPath, output, 'utf-8');
}

/**
 * Read a task's output
 *
 * @param taskId - The task ID
 * @param options - Read options
 * @returns The output content
 */
export async function readTaskOutput(
  taskId: string,
  options: { tail?: number } = {}
): Promise<string> {
  const outputPath = getTaskOutputPath(taskId);

  try {
    const content = await fs.readFile(outputPath, 'utf-8');

    if (options.tail && options.tail > 0) {
      const lines = content.split('\n');
      return lines.slice(-options.tail).join('\n');
    }

    return content;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * List all tasks
 *
 * @param filter - Optional filter
 * @returns Array of tasks
 */
export async function listTasks(
  filter?: {
    status?: BackgroundTaskStatus;
    sessionId?: string;
  }
): Promise<BackgroundTask[]> {
  await ensureTasksDir();

  const files = await fs.readdir(TASKS_DIR);
  const metadataFiles = files.filter((f) => f.endsWith('.json'));

  const tasks: BackgroundTask[] = [];

  for (const file of metadataFiles) {
    try {
      const content = await fs.readFile(path.join(TASKS_DIR, file), 'utf-8');
      const task = JSON.parse(content) as BackgroundTask;

      // Apply filters
      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.sessionId && task.sessionId !== filter.sessionId) continue;

      tasks.push(task);
    } catch {
      // Skip invalid files
    }
  }

  // Sort by start time (newest first)
  return tasks.sort((a, b) => b.startTime - a.startTime);
}

/**
 * Find orphaned tasks (tasks marked as running but process is gone)
 */
export async function findOrphanedTasks(): Promise<BackgroundTask[]> {
  const runningTasks = await listTasks({ status: 'running' });
  const orphaned: BackgroundTask[] = [];

  for (const task of runningTasks) {
    if (task.pid) {
      // Check if process is still running
      try {
        process.kill(task.pid, 0); // Signal 0 just checks if process exists
      } catch {
        // Process not found - task is orphaned
        orphaned.push(task);
      }
    } else {
      // No PID recorded - consider orphaned if old enough (> 1 hour)
      const age = Date.now() - task.startTime;
      if (age > 60 * 60 * 1000) {
        orphaned.push(task);
      }
    }
  }

  return orphaned;
}

/**
 * Clean up orphaned tasks
 */
export async function cleanupOrphanedTasks(): Promise<number> {
  const orphaned = await findOrphanedTasks();

  for (const task of orphaned) {
    await updateTaskStatus(task.taskId, 'orphaned', {
      error: 'Process terminated unexpectedly',
    });
    logger.info('Marked task as orphaned', { taskId: task.taskId });
  }

  return orphaned.length;
}

/**
 * Delete old completed/failed tasks
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 7 days)
 * @returns Number of tasks deleted
 */
export async function cleanupOldTasks(
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  await ensureTasksDir();

  const files = await fs.readdir(TASKS_DIR);
  const metadataFiles = files.filter((f) => f.endsWith('.json'));

  let deleted = 0;
  const now = Date.now();

  for (const file of metadataFiles) {
    try {
      const filePath = path.join(TASKS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const task = JSON.parse(content) as BackgroundTask;

      // Only delete completed/failed/orphaned tasks
      if (task.status === 'running') continue;

      const taskTime = task.endTime || task.startTime;
      if (now - taskTime > maxAgeMs) {
        // Delete metadata and log file
        const taskId = task.taskId;
        await fs.unlink(getTaskMetadataPath(taskId)).catch(() => {});
        await fs.unlink(getTaskOutputPath(taskId)).catch(() => {});
        deleted++;
      }
    } catch {
      // Skip errors
    }
  }

  if (deleted > 0) {
    logger.info('Cleaned up old tasks', { deleted });
  }

  return deleted;
}

/**
 * Get tasks directory path
 */
export function getTasksDirectory(): string {
  return TASKS_DIR;
}

/**
 * Initialize task persistence (call on app startup)
 * - Ensures directory exists
 * - Cleans up orphaned tasks
 * - Cleans up old tasks
 */
export async function initializeTaskPersistence(): Promise<void> {
  await ensureTasksDir();
  await cleanupOrphanedTasks();
  await cleanupOldTasks();
  logger.info('Background task persistence initialized');
}
