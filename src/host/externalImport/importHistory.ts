import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RecentExternalChatImportResult } from '../../shared/contract/agentEngine';
import type { ExternalSkillsApplyResultItem } from '../../shared/contract/externalImport';
import type {
  ImportHistoryEntry,
  ImportHistoryItem,
  ImportHistorySource,
  ImportHistoryTrigger,
} from '../../shared/contract/importHistory';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

const HISTORY_FILE = 'external-import-history.json';
const MAX_ENTRIES = 200;
const MAX_ITEMS = 100;
const logger = createLogger('ExternalImportHistory');

interface RecordOptions {
  trigger?: ImportHistoryTrigger;
  now?: () => number;
}

type NewEntry = Omit<ImportHistoryEntry, 'id' | 'at'>;

function historyPath(): string {
  return path.join(getUserConfigDir(), HISTORY_FILE);
}

function isEntry(value: unknown): value is ImportHistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ImportHistoryEntry>;
  return typeof entry.id === 'string'
    && typeof entry.at === 'number'
    && Number.isFinite(entry.at)
    && (entry.trigger === 'manual' || entry.trigger === 'auto')
    && (entry.category === 'chats' || entry.category === 'skills')
    && typeof entry.source === 'string'
    && typeof entry.count === 'number'
    && Array.isArray(entry.items)
    && entry.items.every((item) => item && typeof item.label === 'string' && typeof item.outcome === 'string');
}

async function readEntries(): Promise<ImportHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath(), 'utf8')) as {
      version?: unknown;
      entries?: unknown;
    };
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) {
      throw new Error('invalid import history shape');
    }
    return parsed.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('import history read failed; using an empty history', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

async function writeEntries(entries: ImportHistoryEntry[]): Promise<void> {
  await fs.mkdir(getUserConfigDir(), { recursive: true });
  await fs.writeFile(historyPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
}

async function appendEntries(entries: NewEntry[], options: RecordOptions): Promise<void> {
  const trigger = options.trigger ?? 'manual';
  const recordable = trigger === 'auto' ? entries.filter((entry) => entry.count >= 1) : entries;
  if (recordable.length === 0) return;
  try {
    const at = (options.now ?? Date.now)();
    const existing = await readEntries();
    const added = recordable.map((entry) => ({
      ...entry,
      items: entry.items.slice(0, MAX_ITEMS),
      id: randomUUID(),
      at,
    }));
    const next = [...added, ...existing].slice(0, MAX_ENTRIES);
    await writeEntries(next);
  } catch (error) {
    logger.warn('import history write failed; import result is unchanged', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordChatImportHistory(
  results: RecentExternalChatImportResult[],
  options: RecordOptions = {},
): Promise<void> {
  const groups = new Map<ImportHistorySource, RecentExternalChatImportResult[]>();
  for (const result of results) {
    const group = groups.get(result.engine) ?? [];
    group.push(result);
    groups.set(result.engine, group);
  }
  await appendEntries(Array.from(groups, ([source, items]) => ({
    trigger: options.trigger ?? 'manual',
    category: 'chats',
    source,
    count: items.filter((item) => item.status === 'imported').length,
    items: items.map((item): ImportHistoryItem => ({
      label: item.title,
      outcome: item.status,
      sourceSessionId: item.sourceSessionId,
    })),
  })), options);
}

export async function recordSkillsImportHistory(
  results: ExternalSkillsApplyResultItem[],
  options: RecordOptions = {},
): Promise<void> {
  const groups = new Map<ImportHistorySource, ExternalSkillsApplyResultItem[]>();
  for (const result of results) {
    const group = groups.get(result.sourceId) ?? [];
    group.push(result);
    groups.set(result.sourceId, group);
  }
  await appendEntries(Array.from(groups, ([source, items]) => ({
    trigger: options.trigger ?? 'manual',
    category: 'skills',
    source,
    count: items.filter((item) => item.action === 'copied').length,
    items: items.map((item): ImportHistoryItem => ({
      label: item.name,
      outcome: item.action,
      ...(item.digest ? { digest: item.digest } : {}),
    })),
  })), options);
}

export async function listImportHistory(): Promise<ImportHistoryEntry[]> {
  return readEntries();
}

/** 回写单条历史（撤销结果落盘用）；条目不存在返回 null。 */
export async function updateImportHistoryEntry(
  entryId: string,
  update: (entry: ImportHistoryEntry) => ImportHistoryEntry,
): Promise<ImportHistoryEntry | null> {
  const entries = await readEntries();
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return null;
  const updated = update(entries[index]);
  entries[index] = updated;
  await writeEntries(entries);
  return updated;
}
