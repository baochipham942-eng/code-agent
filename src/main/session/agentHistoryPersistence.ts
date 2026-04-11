// ============================================================================
// Agent History Persistence - 持久化已完成的 Agent 运行记录
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import type { CompletedAgentRun } from '../../shared/types/agentHistory';

const logger = createLogger('AgentHistoryPersistence');

/** 每个 session 最多保留的记录数 */
const MAX_RUNS_PER_SESSION = 10;

/** resultPreview 最大字符数 */
const MAX_PREVIEW_LENGTH = 200;

/** 历史文件名 */
const HISTORY_FILE = 'agent-history.json';

// ----------------------------------------------------------------------------
// Internal: File I/O
// ----------------------------------------------------------------------------

interface HistoryStore {
  /** sessionId -> CompletedAgentRun[] */
  sessions: Record<string, CompletedAgentRun[]>;
}

function getHistoryFilePath(): string {
  return path.join(getUserConfigDir(), HISTORY_FILE);
}

async function readStore(): Promise<HistoryStore> {
  try {
    const content = await fs.readFile(getHistoryFilePath(), 'utf-8');
    return JSON.parse(content) as HistoryStore;
  } catch {
    return { sessions: {} };
  }
}

async function writeStore(store: HistoryStore): Promise<void> {
  const filePath = getHistoryFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 持久化一条 Agent 运行记录
 */
export async function persistAgentRun(
  sessionId: string,
  run: CompletedAgentRun,
): Promise<void> {
  try {
    const store = await readStore();

    // 截断 resultPreview
    const sanitizedRun: CompletedAgentRun = {
      ...run,
      resultPreview: run.resultPreview
        ? run.resultPreview.slice(0, MAX_PREVIEW_LENGTH)
        : undefined,
    };

    if (!store.sessions[sessionId]) {
      store.sessions[sessionId] = [];
    }

    store.sessions[sessionId].push(sanitizedRun);

    // 超出限制时裁剪最老的
    if (store.sessions[sessionId].length > MAX_RUNS_PER_SESSION) {
      store.sessions[sessionId] = store.sessions[sessionId].slice(
        -MAX_RUNS_PER_SESSION,
      );
    }

    await writeStore(store);
    logger.debug(`Persisted agent run ${run.id} for session ${sessionId}`);
  } catch (error) {
    logger.error('Failed to persist agent run:', error);
  }
}

/**
 * 读取指定 session 的 agent 历史
 */
export async function getAgentHistory(
  sessionId: string,
): Promise<CompletedAgentRun[]> {
  try {
    const store = await readStore();
    return store.sessions[sessionId] ?? [];
  } catch (error) {
    logger.error('Failed to read agent history:', error);
    return [];
  }
}

/**
 * 跨 session 查最近完成的 runs
 */
export async function getRecentAgentHistory(
  limit: number = 10,
): Promise<CompletedAgentRun[]> {
  try {
    const store = await readStore();
    const allRuns: CompletedAgentRun[] = [];

    for (const runs of Object.values(store.sessions)) {
      allRuns.push(...runs);
    }

    // 按 endTime 降序，取最近 N 条
    allRuns.sort((a, b) => b.endTime - a.endTime);
    return allRuns.slice(0, limit);
  } catch (error) {
    logger.error('Failed to read recent agent history:', error);
    return [];
  }
}
