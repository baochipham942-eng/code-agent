// ============================================================================
// Skills sync preference - 「保持技能同步」三态开关 + 已处理技能台账（N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS）
// ============================================================================
//
// 存储位置: <userConfigDir>/external-skills-sync.json
// 格式: { version: 1, mode, lastRun?: { at, imported, keptNeo }, handled: { codex: string[], cursor: string[] } }
// handled 台账记「来源里已经处理过的技能名」（复制过 / Neo 已有同名而跳过），
// 这样撤销或手动删除后的技能不会在下次启动被自动带回来。缺失 = off；损坏 = off 并 warn 出原因。

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../config';
import { createLogger } from '../services/infra/logger';
import type { ExternalSkillCopySourceId } from '../../shared/contract/externalImport';

const logger = createLogger('SkillsSyncPreference');
const PREFERENCE_FILE = 'external-skills-sync.json';

export type SkillsSyncMode = 'off' | 'on' | 'paused';
type SkillsSyncHandled = Record<ExternalSkillCopySourceId, string[]>;

interface SkillsSyncLastRun {
  at: number;
  imported: number;
  keptNeo: number;
}

/** 对外（IPC / UI）可见的状态；台账不外露。 */
export interface SkillsSyncState {
  mode: SkillsSyncMode;
  lastRun?: SkillsSyncLastRun;
}

interface StoredState extends SkillsSyncState {
  handled: SkillsSyncHandled;
}

function emptyState(): StoredState {
  return { mode: 'off', handled: { codex: [], cursor: [] } };
}

function preferenceFilePath(): string {
  return path.join(getUserConfigDir(), PREFERENCE_FILE);
}

function isMode(value: unknown): value is SkillsSyncMode {
  return value === 'off' || value === 'on' || value === 'paused';
}

function toNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function readSkillsSyncStored(): StoredState {
  const filePath = preferenceFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('Failed to read skills sync preference, treating as off', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      lastRun?: { at?: unknown; imported?: unknown; keptNeo?: unknown };
      handled?: { codex?: unknown; cursor?: unknown };
    };
    if (!parsed || !isMode(parsed.mode)) {
      logger.warn('Skills sync preference has no valid mode, treating as off', { filePath });
      return emptyState();
    }
    const state: StoredState = {
      mode: parsed.mode,
      handled: { codex: toNames(parsed.handled?.codex), cursor: toNames(parsed.handled?.cursor) },
    };
    const lastRun = parsed.lastRun;
    if (lastRun && typeof lastRun.at === 'number' && typeof lastRun.imported === 'number') {
      state.lastRun = {
        at: lastRun.at,
        imported: lastRun.imported,
        keptNeo: typeof lastRun.keptNeo === 'number' ? lastRun.keptNeo : 0,
      };
    }
    return state;
  } catch (err) {
    logger.warn('Skills sync preference is corrupt, treating as off', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyState();
  }
}

export function readSkillsSyncState(): SkillsSyncState {
  const { mode, lastRun } = readSkillsSyncStored();
  return { mode, ...(lastRun ? { lastRun } : {}) };
}

/** 写入失败只 warn，调用方以回读值为准。 */
export function writeSkillsSyncStored(state: StoredState): void {
  const filePath = preferenceFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('Failed to persist skills sync preference', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
