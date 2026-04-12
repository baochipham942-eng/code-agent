import type { Message } from '../../shared/contract';
import type { ContextProvenanceCategory } from '../../shared/contract/contextView';
import type { SwarmAgentContextSnapshot } from '../../shared/contract/swarm';
import { CompressionState } from './compressionState';
import { getContextEventLedger } from './contextEventLedger';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { getPath } from '../platform/appPaths';
import { createLogger } from '../services/infra/logger';

export interface SubagentContextAnnotation {
  category?: ContextProvenanceCategory;
  sourceDetail?: string;
  agentId?: string;
  sourceKind?: 'message' | 'tool_result' | 'dependency_carry_over' | 'attachment' | 'compression_survivor' | 'system_anchor';
  layer?: string;
  toolCallId?: string;
}

export interface SubagentContextRecord {
  sessionId: string;
  agentId: string;
  messages: Message[];
  snapshot?: SwarmAgentContextSnapshot;
  annotations?: Record<string, SubagentContextAnnotation>;
  compressionState?: CompressionState;
  maxTokens?: number;
  updatedAt: number;
}

interface StoredSubagentContextRecord extends Omit<SubagentContextRecord, 'compressionState'> {
  compressionState?: string;
}

interface PersistedSubagentContextStore {
  version: 1;
  updatedAt: number;
  records: StoredSubagentContextRecord[];
}

const STALE_RECORD_TTL_MS = 2 * 60 * 60 * 1000;
const STORE_FILE_NAME = 'subagent-context-store.json';

const logger = createLogger('SubagentContextStore');

function buildKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    toolCalls: message.toolCalls ? message.toolCalls.map((toolCall) => ({ ...toolCall })) : undefined,
    toolResults: message.toolResults ? message.toolResults.map((toolResult) => ({ ...toolResult })) : undefined,
    attachments: message.attachments ? message.attachments.map((attachment) => ({ ...attachment })) : undefined,
  };
}

function cloneSnapshot(snapshot?: SwarmAgentContextSnapshot): SwarmAgentContextSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    tools: [...snapshot.tools],
    attachments: [...snapshot.attachments],
    previews: snapshot.previews.map((preview) => ({ ...preview })),
  };
}

export class SubagentContextStore {
  private readonly store = new Map<string, StoredSubagentContextRecord>();
  private readonly persistencePath: string;

  constructor(persistencePath = path.join(getPath('userData'), STORE_FILE_NAME)) {
    this.persistencePath = persistencePath;
    this.loadFromDisk();
  }

  private pruneExpired(now = Date.now()): boolean {
    let removed = false;
    for (const [key, record] of this.store) {
      if (now - record.updatedAt > STALE_RECORD_TTL_MS) {
        this.store.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  private persistToDisk(): void {
    try {
      mkdirSync(path.dirname(this.persistencePath), { recursive: true });

      const payload: PersistedSubagentContextStore = {
        version: 1,
        updatedAt: Date.now(),
        records: Array.from(this.store.values()),
      };

      const tmpPath = `${this.persistencePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      logger.warn('Failed to persist subagent context store', { error, path: this.persistencePath });
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.persistencePath)) return;

    try {
      const raw = readFileSync(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedSubagentContextStore | StoredSubagentContextRecord[];
      const records = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.records)
          ? parsed.records
          : [];

      for (const record of records) {
        const sessionId = record.sessionId?.trim();
        const agentId = record.agentId?.trim();
        if (!sessionId || !agentId) continue;
        this.store.set(buildKey(sessionId, agentId), {
          ...record,
          sessionId,
          agentId,
          messages: Array.isArray(record.messages) ? record.messages.map(cloneMessage) : [],
          annotations: record.annotations ? { ...record.annotations } : undefined,
          compressionState: record.compressionState,
          snapshot: cloneSnapshot(record.snapshot),
          updatedAt: record.updatedAt || Date.now(),
        });
      }

      if (this.pruneExpired()) {
        this.persistToDisk();
      }
    } catch (error) {
      logger.warn('Failed to load persisted subagent context store', { error, path: this.persistencePath });
    }
  }

  upsert(record: SubagentContextRecord): void {
    const expiredPruned = this.pruneExpired();
    const sessionId = record.sessionId?.trim();
    const agentId = record.agentId?.trim();
    if (!sessionId || !agentId) return;

    this.store.set(buildKey(sessionId, agentId), {
      ...record,
      sessionId,
      agentId,
      messages: record.messages.map(cloneMessage),
      annotations: record.annotations ? { ...record.annotations } : undefined,
      compressionState: record.compressionState?.serialize(),
      updatedAt: record.updatedAt || Date.now(),
    });

    const eventLedger = getContextEventLedger();
    eventLedger.upsertAnnotationEvents(sessionId, agentId, record.annotations);
    if (record.compressionState) {
      eventLedger.upsertCompressionEvents(sessionId, agentId, record.compressionState.getCommitLog());
    }

    if (expiredPruned || this.store.size > 0) {
      this.persistToDisk();
    }
  }

  get(sessionId: string, agentId: string): SubagentContextRecord | null {
    const expiredPruned = this.pruneExpired();
    if (expiredPruned) {
      this.persistToDisk();
    }
    const key = buildKey(sessionId.trim(), agentId.trim());
    const record = this.store.get(key);
    if (!record) return null;
    return {
      ...record,
      messages: record.messages.map(cloneMessage),
      annotations: record.annotations ? { ...record.annotations } : undefined,
      snapshot: cloneSnapshot(record.snapshot),
      compressionState: record.compressionState
        ? CompressionState.deserialize(record.compressionState)
        : undefined,
    };
  }

  clearSession(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    let changed = false;
    for (const key of this.store.keys()) {
      if (key.startsWith(`${normalizedSessionId}:`)) {
        this.store.delete(key);
        changed = true;
      }
    }
    if (changed) {
      getContextEventLedger().clearSession(normalizedSessionId);
      this.persistToDisk();
    }
  }
}

let subagentContextStoreSingleton: SubagentContextStore | null = null;

export function getSubagentContextStore(): SubagentContextStore {
  if (!subagentContextStoreSingleton) {
    subagentContextStoreSingleton = new SubagentContextStore();
  }
  return subagentContextStoreSingleton;
}
