// 指挥台任务的「重启中断」收口。
//
// 指挥台任务只活在内存里，账本只落终态：宿主在任务运行中退出/崩溃，会话里就只剩一句
// 「结果会自动回流」，永远等不到结果也等不到失败。这里用每任务一个小 JSON 标记文件
// （目录 <dataDir>/session-command-running/）记「正在跑」：launch 写、settle 删，
// 启动时剩下的标记 = 上个进程没来得及收尾的任务，补一条与正常终态同形的失败消息。
// 选文件而不是扩账本 store：账本 store 只认终态行，加「运行中」行要动 schema 与查询面，
// 而这里只需要「进程死了还剩谁」一个事实；每任务一个文件也避开并发读改写。
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../../../shared/contract';
import { getUserConfigDir } from '../../config/configPaths';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getConfigService } from '../core/configService';
import { getDatabase } from '../core';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../task/backgroundTaskStore';

const logger = createLogger('SessionCommandRestartRecovery');

const SESSION_COMMAND_TASK_INTERRUPTED_REASON = 'session_command_task_interrupted_by_restart';
const MARKER_DIR = 'session-command-running';

interface RunningMarker {
  taskId: string;
  sessionId: string;
  title: string;
  shortName: string;
  createdAt: number;
  startedAt: number;
}

type ResultStatus = 'completed' | 'failed' | 'cancelled';

function markerDir(): string {
  return path.join(getUserConfigDir(), MARKER_DIR);
}

function markerPath(taskId: string): string {
  return path.join(markerDir(), `${encodeURIComponent(taskId)}.json`);
}

/** 任务进入 running 时调用；写失败只 warn，不影响任务本身。 */
export function markSessionCommandTaskRunning(task: {
  id: string;
  sessionId: string;
  title: string;
  shortName: string;
  createdAt: number;
}): void {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    const marker: RunningMarker = {
      taskId: task.id,
      sessionId: task.sessionId,
      title: task.title,
      shortName: task.shortName,
      createdAt: task.createdAt,
      startedAt: Date.now(),
    };
    fs.writeFileSync(markerPath(task.id), JSON.stringify(marker));
  } catch (error) {
    logger.warn('Failed to write running marker; a restart mid-task will not be reported', {
      taskId: task.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearSessionCommandTaskMarker(taskId: string): void {
  try {
    fs.rmSync(markerPath(taskId), { force: true });
  } catch (error) {
    logger.warn('Failed to remove running marker', {
      taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 正常终态与重启中断共用的「[任务结果]」系统消息形状。 */
export function buildSessionTaskResultMessage(
  task: { id: string; shortName: string },
  status: ResultStatus,
  resultText: string | undefined,
  id: string = `session-task-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Message {
  return {
    id,
    role: 'system',
    content: `[任务结果] ${task.shortName}｜${status}｜${resultText}`,
    timestamp: Date.now(),
    metadata: {
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: task.id,
        shortName: task.shortName,
        status,
        summary: resultText ?? '',
      },
    },
  };
}

function interruptedText(locale: 'zh' | 'en'): string {
  return locale === 'zh'
    ? '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。'
    : 'The app restarted while this background task was still running, so it was interrupted and its result could not be delivered. Please start it again if you still need it.';
}

function resolveLocale(): 'zh' | 'en' {
  try {
    return getConfigService().getSettings().ui.language;
  } catch (error) {
    logger.warn('Failed to read UI locale for restart recovery; using Chinese fallback', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 'zh';
  }
}

function readMarkers(): Array<{ file: string; marker: RunningMarker }> {
  const dir = markerDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to list running markers', { message: error instanceof Error ? error.message : String(error) });
    }
    return [];
  }
  const out: Array<{ file: string; marker: RunningMarker }> = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as RunningMarker;
      if (marker.taskId && marker.sessionId) out.push({ file, marker });
      else fs.rmSync(file, { force: true });
    } catch (error) {
      logger.warn('Dropping unreadable running marker', { file, message: error instanceof Error ? error.message : String(error) });
      fs.rmSync(file, { force: true });
    }
  }
  return out;
}

/**
 * 启动期（DB 就绪后）调用：每个遗留标记补一条 failed 的 [任务结果] 消息 + 账本终态行，再删标记。
 * 幂等：消息 id 由 taskId 派生（重复写走 addMessage 的幂等分支），标记删了第二次启动什么都不写。
 * 返回补写的任务数。
 */
export async function recoverInterruptedSessionCommandTasks(): Promise<number> {
  const markers = readMarkers();
  if (markers.length === 0) return 0;
  const locale = resolveLocale();
  const text = interruptedText(locale);
  const ledger = getBackgroundTaskLedger();
  try {
    const db = getDatabase().getDb();
    if (db) ledger.setStore(new SqliteBackgroundTaskStore(db));
  } catch (error) {
    logger.warn('Background task store unavailable during restart recovery; ledger rows stay in memory', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let recovered = 0;
  for (const { file, marker } of markers) {
    try {
      await getSessionManager().addMessageToSession(
        marker.sessionId,
        buildSessionTaskResultMessage(
          { id: marker.taskId, shortName: marker.shortName },
          'failed',
          text,
          `session-task-result-interrupted-${marker.taskId}`,
        ),
      );
    } catch (error) {
      logger.warn('Restart recovery could not write the interruption message', {
        taskId: marker.taskId,
        sessionId: marker.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      fs.rmSync(file, { force: true });
      continue;
    }
    try {
      const now = Date.now();
      ledger.upsertTask({
        id: marker.taskId,
        kind: 'session_command_task',
        source: 'session_command_center',
        sessionId: marker.sessionId,
        runId: marker.taskId,
        title: marker.title,
        summary: text,
        status: 'failed',
        createdAt: marker.createdAt,
        updatedAt: now,
        startedAt: marker.startedAt,
        completedAt: now,
        failure: { message: text, reason: SESSION_COMMAND_TASK_INTERRUPTED_REASON },
        metadata: { shortName: marker.shortName, childRunId: marker.taskId },
      });
    } catch (error) {
      logger.warn('Restart recovery could not record the ledger row', {
        taskId: marker.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    fs.rmSync(file, { force: true });
    recovered += 1;
    logger.warn('Session command task interrupted by app restart; failure message written', {
      taskId: marker.taskId,
      sessionId: marker.sessionId,
    });
  }
  return recovered;
}
