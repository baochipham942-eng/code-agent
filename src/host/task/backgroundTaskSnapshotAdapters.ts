import { statSync } from 'fs';
import type {
  Task,
  TaskFailure,
  TaskOutputRef,
  TaskStatus,
} from '../../shared/contract/backgroundTask';
import { isTerminalTaskStatus } from '../../shared/contract/backgroundTask';
import type { BackgroundTaskStore } from './backgroundTaskStore';
import {
  getAllBackgroundTasks,
  getAllPtySessions,
  onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent,
  type PtySessionInfo,
  type TaskInfo,
} from '../tools/modules/shell/backgroundTaskSources';
import { type BackgroundTaskLedger, getBackgroundTaskLedger } from './backgroundTaskLedger';
import { buildBackgroundTaskRecoveryPlan } from './backgroundTaskRecoveryPlan';

type ShellLikeStatus = 'running' | 'completed' | 'failed';

const EMPTY_OUTPUT_MESSAGE = 'Process completed with exit code 0 but produced no output.';

function getOutputFileSize(outputFile?: string): number | undefined {
  if (!outputFile) return undefined;
  try {
    return statSync(outputFile).size;
  } catch {
    return undefined;
  }
}

function isEmptyOutputFile(outputFile?: string): boolean {
  const size = getOutputFileSize(outputFile);
  return size === undefined || size === 0;
}

function mapShellStatus(status: ShellLikeStatus, outputFile?: string): TaskStatus {
  if (status === 'completed') return isEmptyOutputFile(outputFile) ? 'failed' : 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}

function buildFailure(
  sourceStatus: ShellLikeStatus,
  mappedStatus: TaskStatus,
  exitCode?: number,
): TaskFailure | undefined {
  if (mappedStatus !== 'failed') return undefined;
  if (sourceStatus === 'completed') {
    return { message: EMPTY_OUTPUT_MESSAGE, exitCode, category: 'empty_output' };
  }
  return {
    message: exitCode != null
      ? `Process exited with code ${exitCode}`
      : 'Process failed',
    exitCode,
    category: 'command_failed',
  };
}

function upsertOutputRef(ledger: BackgroundTaskLedger, ref: TaskOutputRef): void {
  ledger.addOutputRef({
    id: ref.id,
    taskId: ref.taskId,
    type: ref.type,
    label: ref.label,
    path: ref.path,
    uri: ref.uri,
    mimeType: ref.mimeType,
    size: ref.size,
    createdAt: ref.createdAt,
    metadata: ref.metadata,
  });
}

function persistRunningSnapshotIfAvailable(ledger: BackgroundTaskLedger, task: Task): void {
  if (isTerminalTaskStatus(task.status)) return;
  const store = (ledger as unknown as { store?: BackgroundTaskStore }).store;
  store?.upsertTask(task);
}

function shouldQueueTerminalNotification(previous: Task | null, status: TaskStatus): boolean {
  if (!isTerminalTaskStatus(status)) return false;
  return previous?.status !== status;
}

function buildTerminalMessage(args: {
  label: string;
  status: TaskStatus;
  durationMs?: number;
  exitCode?: number;
  outputFile?: string;
}): string {
  const duration = args.durationMs != null ? `，耗时 ${formatDuration(args.durationMs)}` : '';
  const log = args.outputFile ? `，日志 ${args.outputFile}` : '';
  if (args.status === 'completed') {
    return `${args.label} 已完成${duration}${log}`;
  }
  const exitCode = args.exitCode != null ? `，退出码 ${args.exitCode}` : '';
  return `${args.label} 失败${exitCode}${duration}${log}`;
}

function queueTerminalNotification(args: {
  ledger: BackgroundTaskLedger;
  previous: Task | null;
  taskId: string;
  sessionId?: string;
  source: 'shell' | 'pty';
  title: string;
  status: TaskStatus;
  durationMs?: number;
  exitCode?: number;
  outputFile?: string;
}): void {
  if (!args.sessionId || !shouldQueueTerminalNotification(args.previous, args.status)) {
    return;
  }

  args.ledger.queueNotification({
    id: `${args.taskId}:terminal:${args.status}`,
    taskId: args.taskId,
    sessionId: args.sessionId,
    type: args.status === 'completed' ? 'task_completed' : 'task_failed',
    title: args.status === 'completed' ? '后台任务完成' : '后台任务失败',
    message: buildTerminalMessage({
      label: args.title,
      status: args.status,
      durationMs: args.durationMs,
      exitCode: args.exitCode,
      outputFile: args.outputFile,
    }),
    payload: {
      taskId: args.taskId,
      source: args.source,
      status: args.status,
      outputFile: args.outputFile,
      exitCode: args.exitCode,
      durationMs: args.durationMs,
    },
  });
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return '不到 1 秒';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

export function syncShellTaskSnapshotToLedger(
  task: TaskInfo,
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): void {
  const status = mapShellStatus(task.status, task.outputFile);
  const taskId = `shell:${task.taskId}`;
  const previous = ledger.getTask(taskId);
  const recoveryStatus = status === 'running' ? 'running-live' : status;
  ledger.upsertTask({
    id: taskId,
    kind: 'shell',
    sessionId: task.sessionId,
    toolCallId: task.toolCallId,
    source: 'shell',
    title: task.command || `Shell ${task.taskId.slice(0, 8)}`,
    summary: task.outputFile,
    command: task.command,
    cwd: task.cwd,
    status,
    createdAt: task.startTime,
    updatedAt: task.endTime ?? Date.now(),
    startedAt: task.startTime,
    completedAt: task.endTime,
    durationMs: task.duration,
    failure: buildFailure(task.status, status, task.exitCode),
    metadata: {
      createdBy: 'neo',
      originalTaskId: task.taskId,
      exitCode: task.exitCode,
      recoveryStatus,
      recoveryPlan: buildBackgroundTaskRecoveryPlan({
        status,
        recoveryStatus,
        outputFile: task.outputFile,
        exitCode: task.exitCode,
      }),
    },
  });

  queueTerminalNotification({
    ledger,
    previous,
    taskId,
    sessionId: task.sessionId,
    source: 'shell',
    title: task.command || `Shell ${task.taskId.slice(0, 8)}`,
    status,
    durationMs: task.duration,
    exitCode: task.exitCode,
    outputFile: task.outputFile,
  });

  upsertOutputRef(ledger, {
    id: `${taskId}:log`,
    taskId,
    type: 'log',
    label: 'Shell log',
    path: task.outputFile,
    size: getOutputFileSize(task.outputFile),
    createdAt: task.startTime,
    metadata: {
      originalTaskId: task.taskId,
    },
  });
  const updatedTask = ledger.getTask(taskId);
  if (updatedTask) {
    persistRunningSnapshotIfAvailable(ledger, updatedTask);
  }
}

export function syncShellTaskSnapshotsToLedger(
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): void {
  for (const task of getAllBackgroundTasks()) {
    syncShellTaskSnapshotToLedger(task, ledger);
  }
}

export function syncPtySessionSnapshotToLedger(
  session: PtySessionInfo,
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): void {
  const status = mapShellStatus(session.status, session.outputFile);
  const taskId = `pty:${session.sessionId}`;
  const command = [session.command, ...session.args].filter(Boolean).join(' ');
  const previous = ledger.getTask(taskId);
  const recoveryStatus = status === 'running' ? 'running-live' : status;
  ledger.upsertTask({
    id: taskId,
    kind: 'pty',
    sessionId: session.ownerSessionId,
    toolCallId: session.toolCallId,
    source: 'pty',
    title: command || `PTY ${session.sessionId.slice(0, 8)}`,
    summary: session.outputFile,
    command,
    cwd: session.cwd,
    status,
    createdAt: session.startTime,
    updatedAt: session.endTime ?? Date.now(),
    startedAt: session.startTime,
    completedAt: session.endTime,
    durationMs: session.duration,
    failure: buildFailure(session.status, status, session.exitCode),
    metadata: {
      createdBy: 'neo',
      originalSessionId: session.sessionId,
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      recoveryStatus,
      recoveryPlan: buildBackgroundTaskRecoveryPlan({
        status,
        recoveryStatus,
        outputFile: session.outputFile,
        exitCode: session.exitCode,
      }),
    },
  });

  queueTerminalNotification({
    ledger,
    previous,
    taskId,
    sessionId: session.ownerSessionId,
    source: 'pty',
    title: command || `PTY ${session.sessionId.slice(0, 8)}`,
    status,
    durationMs: session.duration,
    exitCode: session.exitCode,
    outputFile: session.outputFile,
  });

  upsertOutputRef(ledger, {
    id: `${taskId}:log`,
    taskId,
    type: 'log',
    label: 'PTY log',
    path: session.outputFile,
    size: getOutputFileSize(session.outputFile),
    createdAt: session.startTime,
    metadata: {
      originalSessionId: session.sessionId,
    },
  });
  const updatedTask = ledger.getTask(taskId);
  if (updatedTask) {
    persistRunningSnapshotIfAvailable(ledger, updatedTask);
  }
}

export function syncPtySessionSnapshotsToLedger(
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): void {
  for (const session of getAllPtySessions()) {
    syncPtySessionSnapshotToLedger(session, ledger);
  }
}

export function syncBackgroundTaskSnapshotsToLedger(
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): void {
  syncShellTaskSnapshotsToLedger(ledger);
  syncPtySessionSnapshotsToLedger(ledger);
}

let detachBackgroundTaskEventAdapters: (() => void) | null = null;

export function installBackgroundTaskEventAdapters(
  ledger: BackgroundTaskLedger = getBackgroundTaskLedger(),
): () => void {
  if (detachBackgroundTaskEventAdapters) {
    return detachBackgroundTaskEventAdapters;
  }

  const detachShell = onBackgroundTaskLifecycleEvent((event) => {
    syncShellTaskSnapshotToLedger(event.task, ledger);
  });
  const detachPty = onPtySessionLifecycleEvent((event) => {
    syncPtySessionSnapshotToLedger(event.session, ledger);
  });

  detachBackgroundTaskEventAdapters = () => {
    detachShell();
    detachPty();
    detachBackgroundTaskEventAdapters = null;
  };

  return detachBackgroundTaskEventAdapters;
}

export function resetBackgroundTaskEventAdaptersForTest(): void {
  detachBackgroundTaskEventAdapters?.();
}
