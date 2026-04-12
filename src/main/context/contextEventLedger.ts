import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { getPath } from '../platform/appPaths';
import { createLogger } from '../services/infra/logger';
import type {
  ContextProvenanceAction,
  ContextProvenanceCategory,
} from '../../shared/contract/contextView';
import type { CompressionCommit } from './compressionState';
import type { SubagentContextAnnotation } from './subagentContextStore';

export type ContextEventSourceKind =
  | 'message'
  | 'tool_result'
  | 'dependency_carry_over'
  | 'attachment'
  | 'compression_survivor'
  | 'system_anchor';

export interface ContextEventRecord {
  id: string;
  sessionId: string;
  agentId?: string;
  messageId?: string;
  category?: ContextProvenanceCategory;
  action?: ContextProvenanceAction;
  sourceKind?: ContextEventSourceKind;
  sourceDetail?: string;
  layer?: string;
  reason?: string;
  timestamp: number;
}

interface PersistedContextEventLedger {
  version: 1;
  updatedAt: number;
  records: ContextEventRecord[];
}

const LEDGER_FILE_NAME = 'context-event-ledger.json';
const STALE_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const logger = createLogger('ContextEventLedger');

function buildEventId(event: Omit<ContextEventRecord, 'id'>): string {
  return [
    event.sessionId,
    event.agentId || 'global',
    event.messageId || 'session',
    event.category || 'uncategorized',
    event.action || 'added',
    event.sourceKind || 'message',
    event.layer || 'none',
    event.sourceDetail || 'none',
  ].join('::');
}

function normalizeEvent(event: ContextEventRecord): ContextEventRecord | null {
  const sessionId = event.sessionId?.trim();
  if (!sessionId) return null;
  const agentId = event.agentId?.trim() || undefined;
  const messageId = event.messageId?.trim() || undefined;
  const normalized: Omit<ContextEventRecord, 'id'> = {
    ...event,
    sessionId,
    agentId,
    messageId,
    timestamp: event.timestamp || Date.now(),
  };
  return {
    ...normalized,
    id: buildEventId(normalized),
  };
}

function mapCategoryToAction(category?: ContextProvenanceCategory): ContextProvenanceAction {
  switch (category) {
    case 'tool_result':
    case 'attachment':
    case 'dependency_carry_over':
      return 'retrieved';
    case 'compression_survivor':
      return 'compressed';
    case 'excluded':
      return 'excluded';
    case 'manual_pin_retain':
      return 'retained';
    default:
      return 'added';
  }
}

export class ContextEventLedger {
  private readonly store = new Map<string, ContextEventRecord>();
  private readonly persistencePath: string;

  constructor(persistencePath = path.join(getPath('userData'), LEDGER_FILE_NAME)) {
    this.persistencePath = persistencePath;
    this.loadFromDisk();
  }

  private pruneExpired(now = Date.now()): boolean {
    let removed = false;
    for (const [key, record] of this.store) {
      if (now - record.timestamp > STALE_EVENT_TTL_MS) {
        this.store.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  private persistToDisk(): void {
    try {
      mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const payload: PersistedContextEventLedger = {
        version: 1,
        updatedAt: Date.now(),
        records: Array.from(this.store.values()),
      };
      const tmpPath = `${this.persistencePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      logger.warn('Failed to persist context event ledger', { error, path: this.persistencePath });
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.persistencePath)) return;
    try {
      const raw = readFileSync(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedContextEventLedger | ContextEventRecord[];
      const records = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.records)
          ? parsed.records
          : [];
      for (const record of records) {
        const normalized = normalizeEvent(record);
        if (normalized) {
          this.store.set(normalized.id, normalized);
        }
      }
      if (this.pruneExpired()) {
        this.persistToDisk();
      }
    } catch (error) {
      logger.warn('Failed to load context event ledger', { error, path: this.persistencePath });
    }
  }

  upsertEvents(events: ContextEventRecord[]): void {
    const expiredPruned = this.pruneExpired();
    let changed = expiredPruned;
    for (const event of events) {
      const normalized = normalizeEvent(event);
      if (!normalized) continue;
      this.store.set(normalized.id, normalized);
      changed = true;
    }
    if (changed) {
      this.persistToDisk();
    }
  }

  upsertCompressionEvents(
    sessionId: string,
    agentId: string | undefined,
    commits: ReadonlyArray<CompressionCommit>,
    resolveMessageId?: (messageId: string) => string,
  ): void {
    const events: ContextEventRecord[] = [];
    for (const commit of commits) {
      for (const targetMessageId of commit.targetMessageIds) {
        const messageId = resolveMessageId?.(targetMessageId) ?? targetMessageId;
        events.push({
          id: '',
          sessionId,
          agentId,
          messageId,
          category: 'compression_survivor',
          action: 'compressed',
          sourceKind: 'compression_survivor',
          sourceDetail: `${commit.layer}:${commit.operation}`,
          layer: commit.layer,
          reason: `${commit.operation} via ${commit.layer}`,
          timestamp: commit.timestamp,
        });
      }
    }
    this.upsertEvents(events);
  }

  upsertAnnotationEvents(
    sessionId: string,
    agentId: string,
    annotations?: Record<string, SubagentContextAnnotation>,
  ): void {
    if (!annotations) return;
    const events = Object.entries(annotations).map(([messageId, annotation]) => ({
      id: '',
      sessionId,
      agentId,
      messageId,
      category: annotation.category,
      action: mapCategoryToAction(annotation.category),
      sourceKind: annotation.sourceKind,
      sourceDetail: annotation.sourceDetail,
      layer: annotation.layer,
      reason: annotation.sourceDetail || annotation.category,
      timestamp: Date.now(),
    }));
    this.upsertEvents(events);
  }

  list(sessionId: string, agentId?: string): ContextEventRecord[] {
    const expiredPruned = this.pruneExpired();
    if (expiredPruned) {
      this.persistToDisk();
    }
    const normalizedSessionId = sessionId.trim();
    const normalizedAgentId = agentId?.trim();

    return Array.from(this.store.values())
      .filter((record) => {
        if (record.sessionId !== normalizedSessionId) return false;
        if (!normalizedAgentId) return !record.agentId;
        return record.agentId === normalizedAgentId || !record.agentId;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  clearSession(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    let changed = false;
    for (const [key, record] of this.store) {
      if (record.sessionId === normalizedSessionId) {
        this.store.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persistToDisk();
    }
  }
}

let contextEventLedgerSingleton: ContextEventLedger | null = null;

export function getContextEventLedger(): ContextEventLedger {
  if (!contextEventLedgerSingleton) {
    contextEventLedgerSingleton = new ContextEventLedger();
  }
  return contextEventLedgerSingleton;
}
