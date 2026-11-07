// ============================================================================
// Undo one external-import history entry (N-EXTHISTORY-IMPORT-SYNC-UNDO)
// ============================================================================
//
// 整批撤销：聊天 → 软删导入的 Neo 会话（台账不动，所以自动同步不会再导回来）；
// 技能 → 删除复制出的目录。已有 fork 子会话的聊天、内容摘要变了的技能一律保留并说明原因。
// 幂等：已撤销的条目直接返回落盘结果。部分失败不抛，逐条留痕。

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isUndoableImportItem,
  type ImportHistoryEntry,
  type ImportHistoryItem,
  type ImportHistoryKeptReason,
  type ImportHistoryUndone,
} from '../../shared/contract/importHistory';
import { getSkillsDir } from '../config';
import { createLogger } from '../services/infra/logger';
import { listImportHistory, updateImportHistoryEntry } from './importHistory';
import { digestSkillDir } from './skillDirDigest';

const logger = createLogger('ExternalImportUndo');

type Outcome = { removed: true } | { removed: false; reason: ImportHistoryKeptReason };

export class ImportUndoError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_UNDOABLE', message: string) {
    super(message);
  }
}

function isImportHistoryEntryUndoable(entry: ImportHistoryEntry): boolean {
  return entry.items.some((item) => isUndoableImportItem(entry, item));
}

async function undoChat(entry: ImportHistoryEntry, item: ImportHistoryItem): Promise<Outcome> {
  const { getDatabase } = await import('../services/core/databaseService');
  const db = getDatabase();
  const exportId = `external-history:${entry.source}:${item.sourceSessionId}`;
  // 只认本条目记录时刻之前落下的台账行：同 exportId 后来重导入（换 owner/project）
  // 写的新行不属于这次撤销，盲取最新会把删错落到新会话上。
  const sessionId = db.findSessionForkImportRoot(exportId, entry.at);
  if (!sessionId || !db.getSession(sessionId)) return { removed: false, reason: 'missing' };
  if (db.hasLiveSessionForkChild(sessionId)) return { removed: false, reason: 'continued' };
  const { getSessionManager } = await import('../services/infra/sessionManager');
  await getSessionManager().deleteSession(sessionId);
  return { removed: true };
}

async function undoSkill(item: ImportHistoryItem): Promise<Outcome> {
  const target = path.join(getSkillsDir().user.new, item.label);
  let current: string;
  try {
    current = await digestSkillDir(target);
  } catch {
    return { removed: false, reason: 'missing' };
  }
  if (current !== item.digest) return { removed: false, reason: 'edited' };
  await fs.rm(target, { recursive: true, force: true });
  return { removed: true };
}

async function refreshSkillDiscovery(): Promise<void> {
  try {
    const { getSkillDiscoveryService } = await import('../services/skills/skillDiscoveryService');
    getSkillDiscoveryService().refreshClaudeLegacySkillsInclusion();
  } catch (error) {
    logger.warn('skills removed but discovery rescan failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function undoImportHistoryEntry(entryId: string): Promise<ImportHistoryEntry> {
  const entry = (await listImportHistory()).find((candidate) => candidate.id === entryId);
  if (!entry) throw new ImportUndoError('NOT_FOUND', `import history entry not found: ${entryId}`);
  if (entry.undone) return entry;
  if (!isImportHistoryEntryUndoable(entry)) {
    throw new ImportUndoError('NOT_UNDOABLE', 'this import history entry carries no references to undo');
  }

  let removed = 0;
  const kept: ImportHistoryUndone['kept'] = [];
  for (const item of entry.items) {
    if (!isUndoableImportItem(entry, item)) continue;
    let outcome: Outcome;
    try {
      outcome = entry.category === 'chats' ? await undoChat(entry, item) : await undoSkill(item);
    } catch (error) {
      logger.warn('import undo item failed; keeping it', {
        category: entry.category,
        label: item.label,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { removed: false, reason: 'missing' };
    }
    if (outcome.removed) {
      removed += 1;
    } else {
      logger.warn('import undo kept item', { category: entry.category, label: item.label, reason: outcome.reason });
      kept.push({ label: item.label, reason: outcome.reason });
    }
  }
  if (entry.category === 'skills' && removed > 0) await refreshSkillDiscovery();

  const undone: ImportHistoryUndone = { at: Date.now(), removed, kept };
  const updated = await updateImportHistoryEntry(entryId, (current) => ({ ...current, undone }));
  return updated ?? { ...entry, undone };
}
