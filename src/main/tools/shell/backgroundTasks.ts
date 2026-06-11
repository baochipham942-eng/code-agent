// ============================================================================
// Background Tasks Manager - Manages background shell processes
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { spawnWindowsShell, killProcessTree } from './platformShell';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getUserConfigDir } from '../../config/configPaths';

// ============================================================================
// Constants
// ============================================================================

const MAX_BACKGROUND_TASKS = 10;
const MAX_BACKGROUND_OUTPUT = 1024 * 1024; // 1MB per task
const BACKGROUND_TASK_MAX_RUNTIME = 10 * 60 * 1000; // 10 minutes
const TASK_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

// ============================================================================
// Types
// ============================================================================

export interface TaskState {
  taskId: string;
  process: ChildProcess;
  output: string[];
  outputFile: string;
  outputStream?: fs.WriteStream;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  maxRuntime: number;
  outputSize: number;
  command: string;
  exitCode?: number;
  lastReadPosition: number;
  /** 主超时定时器 */
  timeout?: NodeJS.Timeout;
  /** 内部 SIGKILL 定时器 */
  killTimeout?: NodeJS.Timeout;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
}

export interface TaskInfo {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  command: string;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
  startTime: number;
  endTime?: number;
  duration: number;
  exitCode?: number;
  outputFile: string;
}

export interface TaskOutput {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  output: string;
  exitCode?: number;
  duration: number;
}

export interface StartBackgroundTaskOptions {
  sessionId?: string;
  toolCallId?: string;
}

export type BackgroundTaskLifecycleEventType = 'started' | 'completed' | 'failed';

export interface BackgroundTaskLifecycleEvent {
  type: BackgroundTaskLifecycleEventType;
  task: TaskInfo;
}

// ============================================================================
// Task Storage
// ============================================================================

const backgroundTasks: Map<string, TaskState> = new Map();
const backgroundTaskEvents = new EventEmitter();
backgroundTaskEvents.setMaxListeners(50);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function isTaskStatus(value: unknown): value is TaskState['status'] {
  return value === 'running' || value === 'completed' || value === 'failed';
}

function parsePersistedTask(value: unknown): PersistedTask | null {
  if (!isRecord(value)) return null;
  const taskId = readString(value, 'taskId');
  const command = readString(value, 'command');
  const cwd = readString(value, 'cwd');
  const startTime = readNumber(value, 'startTime');
  const outputFile = readString(value, 'outputFile');
  const status = value.status;
  if (!taskId || !command || !cwd || startTime === null || !outputFile || !isTaskStatus(status)) {
    return null;
  }
  return { taskId, command, cwd, startTime, outputFile, status };
}

function parsePersistedTasks(value: unknown): PersistedTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const task = parsePersistedTask(entry);
    return task ? [task] : [];
  });
}

// ============================================================================
// Directory Management
// ============================================================================

function getTasksDir(): string {
  const tasksDir = path.join(getUserConfigDir(), 'tasks');
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }
  return tasksDir;
}

function getTaskOutputPath(taskId: string): string {
  return path.join(getTasksDir(), `${taskId}.log`);
}

function toTaskInfo(task: TaskState): TaskInfo {
  return {
    taskId: task.taskId,
    status: task.status,
    command: task.command,
    cwd: task.cwd,
    sessionId: task.sessionId,
    toolCallId: task.toolCallId,
    startTime: task.startTime,
    endTime: task.endTime,
    duration: (task.endTime || Date.now()) - task.startTime,
    exitCode: task.exitCode,
    outputFile: task.outputFile,
  };
}

function emitTaskLifecycleEvent(type: BackgroundTaskLifecycleEventType, task: TaskState): void {
  backgroundTaskEvents.emit('lifecycle', {
    type,
    task: toTaskInfo(task),
  } satisfies BackgroundTaskLifecycleEvent);
}

export function onBackgroundTaskLifecycleEvent(
  listener: (event: BackgroundTaskLifecycleEvent) => void,
): () => void {
  backgroundTaskEvents.on('lifecycle', listener);
  return () => backgroundTaskEvents.off('lifecycle', listener);
}

// ============================================================================
// Task Lifecycle
// ============================================================================

/**
 * Start a background task
 */
export function startBackgroundTask(
  command: string,
  cwd: string,
  maxRuntime: number = BACKGROUND_TASK_MAX_RUNTIME,
  options: StartBackgroundTaskOptions = {},
): { success: boolean; taskId?: string; error?: string; outputFile?: string } {
  // Check task limit
  if (backgroundTasks.size >= MAX_BACKGROUND_TASKS) {
    const cleaned = cleanupCompletedTasks();
    if (cleaned === 0 && backgroundTasks.size >= MAX_BACKGROUND_TASKS) {
      return {
        success: false,
        error: `Maximum number of background tasks (${MAX_BACKGROUND_TASKS}) reached. Use kill_shell to terminate some tasks.`,
      };
    }
  }

  const taskId = uuidv4();
  const outputFile = getTaskOutputPath(taskId);

  // win32 无 bash，走 PowerShell；POSIX 保持 bash -c 原语义
  const proc = process.platform === 'win32'
    ? spawnWindowsShell(command, { cwd, env: { ...process.env } })
    : spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

  // Create output file stream
  const outputStream = fs.createWriteStream(outputFile, { flags: 'w' });

  const taskState: TaskState = {
    taskId,
    process: proc,
    output: [],
    outputFile,
    outputStream,
    status: 'running',
    startTime: Date.now(),
    maxRuntime: Math.min(maxRuntime, BACKGROUND_TASK_MAX_RUNTIME),
    outputSize: 0,
    command,
    lastReadPosition: 0,
    cwd,
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
  };

  // Set timeout for max runtime
  const timeout = setTimeout(() => {
    if (taskState.status === 'running') {
      console.warn(`[BackgroundTasks] Task ${taskId} exceeded max runtime, terminating...`);
      try {
        killProcessTree(proc, 'SIGTERM');
        // 追踪内部 SIGKILL 定时器
        taskState.killTimeout = setTimeout(() => {
          if (taskState.status === 'running') {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 1000);
      } catch (err) {
        console.error(`[BackgroundTasks] Failed to kill task ${taskId}:`, err);
      }
    }
  }, taskState.maxRuntime);

  taskState.timeout = timeout;

  // Handle stdout
  proc.stdout?.on('data', (data: Buffer | string) => {
    const dataStr = data.toString();
    taskState.outputSize += dataStr.length;

    // Write to file
    taskState.outputStream?.write(dataStr);

    // Store in memory (with limit)
    if (taskState.outputSize < MAX_BACKGROUND_OUTPUT) {
      taskState.output.push(dataStr);
    } else if (!taskState.output[taskState.output.length - 1]?.includes('[Output limit reached]')) {
      taskState.output.push('[Output limit reached - further output written to file only]');
    }
  });

  // Handle stderr
  proc.stderr?.on('data', (data: Buffer | string) => {
    const dataStr = data.toString();
    const stderrStr = `[stderr] ${dataStr}`;
    taskState.outputSize += stderrStr.length;

    // Write to file
    taskState.outputStream?.write(stderrStr);

    // Store in memory (with limit)
    if (taskState.outputSize < MAX_BACKGROUND_OUTPUT) {
      taskState.output.push(stderrStr);
    }
  });

  // Handle process close
  proc.on('close', (code) => {
    taskState.status = code === 0 ? 'completed' : 'failed';
    taskState.exitCode = code ?? undefined;
    taskState.endTime = Date.now();

    // 清理所有定时器
    if (taskState.timeout) {
      clearTimeout(taskState.timeout);
    }
    if (taskState.killTimeout) {
      clearTimeout(taskState.killTimeout);
    }

    // Close output stream（幂等：error 与 close 可能先后触发，避免重复 end 抛 ERR_STREAM_WRITE_AFTER_END）
    if (taskState.outputStream && !taskState.outputStream.writableEnded) {
      taskState.outputStream.end();
    }
    emitTaskLifecycleEvent(taskState.status === 'completed' ? 'completed' : 'failed', taskState);
  });

  // Handle process error
  proc.on('error', (err) => {
    taskState.status = 'failed';
    taskState.endTime = Date.now();
    const errorMsg = `[error] ${err.message}`;
    taskState.output.push(errorMsg);
    // 幂等：若 close 已先触发结束流，跳过 write/end，避免 ERR_STREAM_WRITE_AFTER_END
    if (taskState.outputStream && !taskState.outputStream.writableEnded) {
      taskState.outputStream.write(errorMsg + '\n');
      taskState.outputStream.end();
    }

    // 清理所有定时器
    if (taskState.timeout) {
      clearTimeout(taskState.timeout);
    }
    if (taskState.killTimeout) {
      clearTimeout(taskState.killTimeout);
    }
    emitTaskLifecycleEvent('failed', taskState);
  });

  backgroundTasks.set(taskId, taskState);
  emitTaskLifecycleEvent('started', taskState);

  return {
    success: true,
    taskId,
    outputFile,
  };
}

/**
 * Kill a background task
 */
export function killBackgroundTask(taskId: string): { success: boolean; error?: string; message?: string } {
  const task = backgroundTasks.get(taskId);
  if (!task) {
    return { success: false, error: `No task found with ID: ${taskId}` };
  }

  try {
    // 清理现有定时器
    if (task.timeout) {
      clearTimeout(task.timeout);
    }
    if (task.killTimeout) {
      clearTimeout(task.killTimeout);
    }

    // Send SIGTERM first
    killProcessTree(task.process, 'SIGTERM');
    task.outputStream?.end();

    // Wait 1 second, then force kill if still running
    // 追踪这个内部定时器
    task.killTimeout = setTimeout(() => {
      if (task.status === 'running') {
        killProcessTree(task.process, 'SIGKILL');
      }
    }, 1000);

    // Update status
    task.status = 'failed';
    task.endTime = Date.now();

    return {
      success: true,
      message: `Successfully killed task: ${taskId} (${task.command.substring(0, 50)}${task.command.length > 50 ? '...' : ''})`,
    };
  } catch (err) {
    return { success: false, error: `Failed to kill task: ${err}` };
  }
}

/**
 * Get task output
 */
export async function getTaskOutput(
  taskId: string,
  block: boolean = false,
  timeout: number = 30000
): Promise<TaskOutput | null> {
  const task = backgroundTasks.get(taskId);
  if (!task) return null;

  // If blocking and still running, wait
  if (block && task.status === 'running') {
    const startTime = Date.now();

    while (task.status === 'running' && Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const output = task.output.join('');
  const duration = (task.endTime || Date.now()) - task.startTime;

  return {
    taskId,
    status: task.status,
    output,
    exitCode: task.exitCode,
    duration,
  };
}

/**
 * Get all background tasks info
 */
export function getAllBackgroundTasks(): TaskInfo[] {
  const result: TaskInfo[] = [];

  for (const [, task] of backgroundTasks) {
    result.push(toTaskInfo(task));
  }

  return result;
}

/**
 * Get a specific background task
 */
export function getBackgroundTask(taskId: string): TaskState | undefined {
  return backgroundTasks.get(taskId);
}

/**
 * Check if a task ID exists
 */
export function isTaskId(taskId: string): boolean {
  return backgroundTasks.has(taskId);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup completed tasks (remove from memory, keep files)
 * 注意：先收集要删除的 ID，再统一删除，避免迭代中修改 Map
 */
export function cleanupCompletedTasks(): number {
  // 第一步：收集要清理的任务 ID
  const toCleanup: string[] = [];
  for (const [taskId, task] of backgroundTasks) {
    if (task.status !== 'running') {
      toCleanup.push(taskId);
    }
  }

  // 第二步：统一清理
  for (const taskId of toCleanup) {
    const task = backgroundTasks.get(taskId);
    if (task) {
      if (task.timeout) {
        clearTimeout(task.timeout);
      }
      if (task.killTimeout) {
        clearTimeout(task.killTimeout);
      }
      task.outputStream?.end();
      backgroundTasks.delete(taskId);
    }
  }

  return toCleanup.length;
}

/**
 * Cleanup timed out tasks
 */
export function cleanupTimedOutTasks(): void {
  const now = Date.now();

  for (const [taskId, task] of backgroundTasks) {
    if (task.status === 'running' && now - task.startTime > task.maxRuntime) {
      console.warn(`[BackgroundTasks] Task ${taskId} timed out, killing...`);
      killBackgroundTask(taskId);
    }
  }
}

// Start periodic cleanup（捕获 handle + onShutdown 注册 + .unref() 三重保护）
const backgroundTasksCleanupTimer = setInterval(() => {
  cleanupTimedOutTasks();
}, TASK_CLEANUP_INTERVAL);
backgroundTasksCleanupTimer.unref();

import('../../services/infra/gracefulShutdown')
  .then(({ onShutdown }) => {
    onShutdown('shell/backgroundTasks.cleanup', async () => {
      clearInterval(backgroundTasksCleanupTimer);
    });
  })
  .catch(() => { /* shutdown infra 不可用就靠 .unref() */ });

// ============================================================================
// Persistence (for recovery after restart)
// ============================================================================

interface PersistedTask {
  taskId: string;
  command: string;
  cwd: string;
  startTime: number;
  outputFile: string;
  status: 'running' | 'completed' | 'failed';
}

const PERSISTENCE_FILE = path.join(getUserConfigDir(), 'background-tasks.json');

/**
 * Save running tasks for recovery
 */
export function persistRunningTasks(): void {
  const tasks: PersistedTask[] = [];

  for (const [, task] of backgroundTasks) {
    if (task.status === 'running') {
      tasks.push({
        taskId: task.taskId,
        command: task.command,
        cwd: task.cwd,
        startTime: task.startTime,
        outputFile: task.outputFile,
        status: task.status,
      });
    }
  }

  try {
    const dir = path.dirname(PERSISTENCE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error('[BackgroundTasks] Failed to persist tasks:', err);
  }
}

/**
 * Load persisted tasks (called on startup)
 * Note: These tasks are marked as 'failed' since the original process is gone
 */
export function loadPersistedTasks(): PersistedTask[] {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      const data = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
      const tasks = parsePersistedTasks(JSON.parse(data) as unknown);

      // Mark all as failed since the process is gone
      return tasks.map((t) => ({ ...t, status: 'failed' as const }));
    }
  } catch (err) {
    console.error('[BackgroundTasks] Failed to load persisted tasks:', err);
  }
  return [];
}

/**
 * Clear persistence file
 */
export function clearPersistedTasks(): void {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      fs.unlinkSync(PERSISTENCE_FILE);
    }
  } catch (err) {
    console.error('[BackgroundTasks] Failed to clear persisted tasks:', err);
  }
}

// Persist tasks on process exit
// 注意：beforeExit 可能被多次调用，persistRunningTasks 是同步的所以安全
process.on('beforeExit', persistRunningTasks);

// SIGINT/SIGTERM 处理：Electron 主进程会通过 gracefulShutdown 统一处理
// 这里只是备用，确保独立运行时也能正确保存状态
// 注意：persistRunningTasks 是同步函数，可以直接调用
process.on('SIGINT', () => {
  persistRunningTasks();
  // 清理所有运行中任务的定时器
  for (const task of backgroundTasks.values()) {
    if (task.timeout) clearTimeout(task.timeout);
    if (task.killTimeout) clearTimeout(task.killTimeout);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  persistRunningTasks();
  // 清理所有运行中任务的定时器
  for (const task of backgroundTasks.values()) {
    if (task.timeout) clearTimeout(task.timeout);
    if (task.killTimeout) clearTimeout(task.killTimeout);
  }
  process.exit(0);
});
