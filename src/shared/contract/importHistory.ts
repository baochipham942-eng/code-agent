export type ImportHistoryTrigger = 'manual' | 'auto' | 'confirm';
type ImportHistoryCategory = 'chats' | 'skills' | 'instructions';
export type ImportHistorySource = 'claude_code' | 'codex_cli' | 'codex' | 'cursor';
export type ImportHistoryOutcome =
  | 'imported'
  | 'already_imported'
  | 'folder_missing'
  | 'failed'
  | 'copied'
  | 'skipped';

export interface ImportHistoryItem {
  label: string;
  outcome: ImportHistoryOutcome;
  /** 聊天：外部会话 id（与条目 source 共同还原导入台账 exportId），撤销用。 */
  sourceSessionId?: string;
  /** 技能：复制完成时目录内容摘要，撤销时据此判断是否被改过。 */
  digest?: string;
  /** 说明：确认写入的 Light Memory 文件名，撤销时据此定位。 */
  memoryFilename?: string;
  /** 说明：确认时的规则内容摘要，撤销时用于保护用户编辑。 */
  contentHash?: string;
}

export type ImportHistoryKeptReason = 'continued' | 'edited' | 'missing';

export interface ImportHistoryUndone {
  at: number;
  removed: number;
  kept: Array<{ label: string; reason: ImportHistoryKeptReason }>;
}

export interface ImportHistoryEntry {
  id: string;
  at: number;
  trigger: ImportHistoryTrigger;
  category: ImportHistoryCategory;
  source: ImportHistorySource;
  count: number;
  items: ImportHistoryItem[];
  undone?: ImportHistoryUndone;
}

export function isUndoableImportItem(entry: Pick<ImportHistoryEntry, 'category'>, item: ImportHistoryItem): boolean {
  if (entry.category === 'chats') return item.outcome === 'imported' && !!item.sourceSessionId;
  if (entry.category === 'skills') return item.outcome === 'copied' && !!item.digest;
  return item.outcome === 'imported' && !!item.memoryFilename && !!item.contentHash;
}
