// ============================================================================
// Protocol Types — SQLite Repositories
// Data shape contracts for the services/core/repositories layer.
// Downstream consumers should prefer importing from here; the repository
// classes themselves also re-export these for backward compatibility.
//
// Moved from:
//   - services/core/repositories/SessionRepository.ts  (StoredSession, StoredMessage)
//   - services/core/repositories/MemoryRepository.ts   (MemoryRecord, RelationQueryOptions, EntityRelation)
//   - services/core/repositories/ConfigRepository.ts   (UserPreference, ProjectKnowledge, ToolExecution)
// as part of P0-5 phase B (services type sinkdown).
// ============================================================================

import type { Session, Message } from '@shared/contract';

// ---- SessionRepository ----

export interface StoredSession extends Session {
  messageCount: number;
  turnCount?: number;
  isDeleted?: boolean;
}

export interface StoredMessage extends Message {
  sessionId: string;
}

// ---- MemoryRepository ----

export interface MemoryRecord {
  id: string;
  type:
    | 'user_preference'
    | 'code_pattern'
    | 'project_knowledge'
    | 'conversation'
    | 'tool_usage'
    | 'desktop_activity'
    | 'workspace_activity';
  category: string;
  content: string;
  summary?: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath?: string;
  sessionId?: string;
  confidence: number;
  metadata: Record<string, unknown>;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

export interface RelationQueryOptions {
  /** Half-life in days for confidence decay (default: MEMORY.RELATION_DECAY_DAYS) */
  decayDays?: number;
  /** Minimum confidence threshold after decay (default: MEMORY.RELATION_MIN_CONFIDENCE) */
  minConfidence?: number;
}

export interface EntityRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  confidence: number;
  evidence: string;
  createdAt: number;
}

// ---- ConfigRepository ----

export interface UserPreference {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ProjectKnowledge {
  id: string;
  projectPath: string;
  key: string;
  value: string;
  source: 'learned' | 'explicit' | 'inferred';
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolExecution {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  arguments: string; // JSON
  result: string; // JSON
  success: boolean;
  duration: number;
  createdAt: number;
}
