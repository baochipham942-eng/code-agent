import type { TaskStatus } from '../../shared/contract/backgroundTask';

export interface BackgroundTaskRecoveryPlan {
  status:
    | 'running-live'
    | 'running-recovered'
    | 'dead-log-only'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'orphaned';
  recoverable: boolean;
  summary: string;
  recommendedActions: string[];
  controlActions: Array<'poll' | 'open_log' | 'retry' | 'kill' | 'none'>;
  logPath?: string;
}

export function buildBackgroundTaskRecoveryPlan(args: {
  status: TaskStatus;
  recoveryStatus: string;
  outputFile?: string;
  exitCode?: number;
}): BackgroundTaskRecoveryPlan {
  const hasLog = Boolean(args.outputFile);
  const logActions = hasLog ? ['open_log' as const] : [];

  if (args.recoveryStatus === 'running-live') {
    return {
      status: 'running-live',
      recoverable: true,
      summary: hasLog
        ? '任务正在运行，可继续轮询状态或打开日志。'
        : '任务正在运行，可继续轮询状态。',
      recommendedActions: hasLog ? ['poll', 'open_log', 'kill'] : ['poll', 'kill'],
      controlActions: ['poll', ...logActions, 'kill'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  if (args.recoveryStatus === 'running-recovered') {
    return {
      status: 'running-recovered',
      recoverable: true,
      summary: hasLog
        ? '应用重启后检测到进程仍在运行，可继续轮询并查看日志。'
        : '应用重启后检测到进程仍在运行，可继续轮询。',
      recommendedActions: hasLog ? ['poll', 'open_log', 'kill'] : ['poll', 'kill'],
      controlActions: ['poll', ...logActions, 'kill'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  if (args.recoveryStatus === 'dead-log-only' || args.status === 'orphaned') {
    return {
      status: 'dead-log-only',
      recoverable: false,
      summary: hasLog
        ? '应用重启后没有找到运行进程，保留日志，可打开日志后重跑。'
        : '应用重启后没有找到运行进程，可按原命令重跑。',
      recommendedActions: hasLog ? ['open_log', 'retry'] : ['retry'],
      controlActions: [...logActions, 'retry'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  if (args.status === 'completed') {
    return {
      status: 'completed',
      recoverable: true,
      summary: hasLog ? '任务已完成，可打开日志复核输出。' : '任务已完成。',
      recommendedActions: hasLog ? ['open_log'] : ['none'],
      controlActions: hasLog ? ['open_log'] : ['none'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  if (args.status === 'failed') {
    const exitCode = args.exitCode != null ? `退出码 ${args.exitCode}，` : '';
    return {
      status: 'failed',
      recoverable: false,
      summary: hasLog
        ? `任务失败，${exitCode}可打开日志后重跑。`
        : `任务失败，${exitCode}可按原命令重跑。`,
      recommendedActions: hasLog ? ['open_log', 'retry'] : ['retry'],
      controlActions: [...logActions, 'retry'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  if (args.status === 'cancelled' || args.status === 'expired') {
    return {
      status: args.status,
      recoverable: false,
      summary: hasLog ? '任务未继续运行，可查看日志后决定是否重跑。' : '任务未继续运行，可按需重跑。',
      recommendedActions: hasLog ? ['open_log', 'retry'] : ['retry'],
      controlActions: [...logActions, 'retry'],
      ...(args.outputFile ? { logPath: args.outputFile } : {}),
    };
  }

  return {
    status: 'orphaned',
    recoverable: false,
    summary: taskStatusSummary(args.status, hasLog),
    recommendedActions: hasLog ? ['open_log'] : ['none'],
    controlActions: hasLog ? ['open_log'] : ['none'],
    ...(args.outputFile ? { logPath: args.outputFile } : {}),
  };
}

function taskStatusSummary(status: TaskStatus, hasLog: boolean): string {
  if (hasLog) {
    return `任务状态为 ${status}，可打开日志复核。`;
  }
  return `任务状态为 ${status}。`;
}
