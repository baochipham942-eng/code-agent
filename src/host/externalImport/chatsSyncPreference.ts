// ============================================================================
// Chats sync preference - 「保持聊天同步」三态开关（N-EXTHISTORY-IMPORT-SYNC-CHATS）
// ============================================================================
//
// 存储位置: <dataDir>/external-chats-sync.json
// 格式: { version: 1, mode: 'off'|'on'|'paused', lastRun?: { at, imported } }
// 独立文件：claudeLegacySkillsPreference 会整文件重写 external-import.json，
// 共用会把这里的键抹掉。缺失 = off；损坏/不可读 = off 并 warn 出原因（fail-open 但留痕）。

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../config';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ChatsSyncPreference');
const PREFERENCE_FILE = 'external-chats-sync.json';

export type ChatsSyncMode = 'off' | 'on' | 'paused';

interface ChatsSyncLastRun {
  at: number;
  imported: number;
}

export interface ChatsSyncState {
  mode: ChatsSyncMode;
  lastRun?: ChatsSyncLastRun;
}

function preferenceFilePath(): string {
  return path.join(getUserConfigDir(), PREFERENCE_FILE);
}

function isMode(value: unknown): value is ChatsSyncMode {
  return value === 'off' || value === 'on' || value === 'paused';
}

export function readChatsSyncState(): ChatsSyncState {
  const filePath = preferenceFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('Failed to read chats sync preference, treating as off', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { mode: 'off' };
  }
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; lastRun?: { at?: unknown; imported?: unknown } };
    if (!parsed || !isMode(parsed.mode)) {
      logger.warn('Chats sync preference has no valid mode, treating as off', { filePath });
      return { mode: 'off' };
    }
    const lastRun = parsed.lastRun;
    if (lastRun && typeof lastRun.at === 'number' && typeof lastRun.imported === 'number') {
      return { mode: parsed.mode, lastRun: { at: lastRun.at, imported: lastRun.imported } };
    }
    return { mode: parsed.mode };
  } catch (err) {
    logger.warn('Chats sync preference is corrupt, treating as off', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { mode: 'off' };
  }
}

/** 写入失败只 warn，调用方以回读值为准。 */
export function writeChatsSyncState(state: ChatsSyncState): void {
  const filePath = preferenceFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('Failed to persist chats sync preference', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
