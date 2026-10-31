export type ImportHistoryTrigger = 'manual' | 'auto';
type ImportHistoryCategory = 'chats' | 'skills';
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
}

export interface ImportHistoryEntry {
  id: string;
  at: number;
  trigger: ImportHistoryTrigger;
  category: ImportHistoryCategory;
  source: ImportHistorySource;
  count: number;
  items: ImportHistoryItem[];
}
