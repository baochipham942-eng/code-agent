// ============================================================================
// Background Tasks Manager - Manages background shell processes
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

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
}

export interface TaskInfo {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  command: string;
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

// ============================================================================
// Task Storage
// ============================================================================

const backgroundTasks: Map<string, TaskState> = new Map();

// ============================================================================
// Directory Management
// ============================================================================

function getTasksDir(): string {
  const tasksDir = path.join(os.homedir(), '.code-agent', 'tasks');
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }
  return tasksDir;
}

function getTaskOutputPath(taskId: string): string {
  return path.join(getTasksDir(), `${taskId}.log`);
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
  maxRuntime: number = BACKGROUND_TASK_MAX_RUNTIME
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

  const proc = spawn('bash', ['-c', command], {
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
  };

  // Set timeout for max runtime
  const timeout = setTimeout(() => {
    if (taskState.status === 'running') {
      console.warn(`[BackgroundTasks] Task ${taskId} exceeded max runtime, terminating...`);
      try {
        proc.kill('SIGTERM');
        // 追踪内部 SIGKILL 定时器
        taskState.killTimeout = setTimeout(() => {
          if (taskState.status === 'running') {
            proc.kill('SIGKILL');
          }
        }, 1000);
      } catch (err) {
        console.error(`[BackgroundTasks] Failed to kill task ${taskId}:`, err);
      }
    }
  }, taskState.maxRuntime);

  taskState.timeout = timeout;

  // Handle stdout
  proc.stdout?.on('data', (data) => {
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
  proc.stderr?.on('data', (data) => {
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

    // Close output stream
    taskState.outputStream?.end();
  });

  // Handle process error
  proc.on('error', (err) => {
    taskState.status = 'failed';
    const errorMsg = `[error] ${err.message}`;
    taskState.output.push(errorMsg);
    taskState.outputStream?.write(errorMsg + '\n');
    taskState.outputStream?.end();

    // 清理所有定时器
    if (taskState.timeout) {
      clearTimeout(taskState.timeout);
    }
    if (taskState.killTimeout) {
      clearTimeout(taskState.killTimeout);
    }
  });

  backgroundTasks.set(taskId, taskState);

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
    task.process.kill('SIGTERM');
    task.outputStream?.end();

    // Wait 1 second, then force kill if still running
    // 追踪这个内部定时器
    task.killTimeout = setTimeout(() => {
      if (task.status === 'running') {
        task.process.kill('SIGKILL');
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
export function getTaskOutput(
  taskId: string,
  block: boolean = false,
  timeout: number = 30000
): Promise<TaskOutput | null> {
  return new Promise(async (resolve) => {
    const task = backgroundTasks.get(taskId);
    if (!task) {
      resolve(null);
      return;
    }

    // If blocking and still running, wait
    if (block && task.status === 'running') {
      const startTime = Date.now();

      while (task.status === 'running' && Date.now() - startTime < timeout) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const output = task.output.join('');
    const duration = (task.endTime || Date.now()) - task.startTime;

    resolve({
      taskId,
      status: task.status,
      output,
      exitCode: task.exitCode,
      duration,
    });
  });
}

/**
 * Get all background tasks info
 */
export function getAllBackgroundTasks(): TaskInfo[] {
  const result: TaskInfo[] = [];

  for (const [taskId, task] of backgroundTasks) {
    result.push({
      taskId,
      status: task.status,
      command: task.command,
      startTime: task.startTime,
      endTime: task.endTime,
      duration: (task.endTime || Date.now()) - task.startTime,
      exitCode: task.exitCode,
      outputFile: task.outputFile,
    });
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

// Start periodic cleanup
setInterval(() => {
  cleanupTimedOutTasks();
}, TASK_CLEANUP_INTERVAL);

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

const PERSISTENCE_FILE = path.join(os.homedir(), '.code-agent', 'background-tasks.json');

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
      const tasks: PersistedTask[] = JSON.parse(data);

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
