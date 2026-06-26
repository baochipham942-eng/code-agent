// ============================================================================
// SessionRepository parsers — SQL 片段 / JSON 解析 / row-mapper（零行为改动）
// 从 SessionRepository.ts 拆出；SessionRepository 各方法 import 使用。
// ============================================================================

import type { Session, SessionStatus, TokenUsage, Message, ModelProvider, ToolCall } from '../../../../shared/contract';
import { normalizeAgentEngineSession } from '../../../../shared/contract/agentEngine';
import { collectAttachmentPersistenceMetrics, sanitizeAttachmentsForPersistence, stripInlineAttachmentBlocks } from '../../../../shared/utils/messageAttachments';
import { extractArtifacts } from '../../../agent/artifactExtractor';
import { createLogger } from '../../infra/logger';
import { generateFallbackShortDescription } from '../../../model/providers/shared';
import type { StoredSession } from '../../../protocol/types';

const logger = createLogger('SessionRepositoryParsers');

type SQLiteRow = Record<string, unknown>;

export function activeMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.visibility, 'active') = 'active'`;
}

export function loopInternalMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.content, '') NOT LIKE '%【循环模式 · 第%轮】%' AND COALESCE(${alias}.content, '') NOT LIKE '%[[LOOP_WAIT]]%'`;
}

export function visibleHistoryMessageWhere(alias = 'm'): string {
  return `${activeMessageWhere(alias)} AND COALESCE(${alias}.is_meta, 0) = 0 AND ${loopInternalMessageWhere(alias)}`;
}

/**
 * 入库 choke point：保证持久化的所有 ToolCall 都有 shortDescription（产品视角
 * 语义短句）。任何上游路径——messageProcessor / TaskManager.turnState 重构造 /
 * web mode persist / subagent 透传——丢字段时这里统一兜底，避免 UI 看到 stale
 * 旧消息时 fallback 到机械拼接。
 */
export function ensureToolCallShortDescription(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) return toolCalls;
  return toolCalls.map((tc) => ({
    ...tc,
    shortDescription: tc.shortDescription ?? generateFallbackShortDescription(tc.name, tc.arguments ?? {})
  }));
}

export function buildAttachmentMetadata(attachments: Message['attachments']): Message['attachments'] | undefined {
  const sanitized = sanitizeAttachmentsForPersistence(attachments);
  const metrics = collectAttachmentPersistenceMetrics(attachments, sanitized);
  if (metrics.strippedDataUrlCount > 0 || metrics.persistedDataUrlChars > 0) {
    logger.debug('Attachment persistence media profile', metrics);
  }
  return sanitized;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

export function parseStoredJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown as T;
  } catch {
    return undefined;
  }
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function rowToMessage(row: SQLiteRow): Message {
  const content = stripInlineAttachmentBlocks((row.content as string) || '');
  const artifacts = row.role === 'assistant' ? extractArtifacts(content) : [];
  return {
    id: row.id as string,
    role: row.role as Message['role'],
    content,
    timestamp: row.timestamp as number,
    visibility: (row.visibility as Message['visibility']) || 'active',
    hiddenByRewindId: (row.hidden_by_rewind_id as string) || undefined,
    hiddenAt: (row.hidden_at as number) || undefined,
    toolCalls: parseStoredJson<Message['toolCalls']>(row.tool_calls),
    toolResults: parseStoredJson<Message['toolResults']>(row.tool_results),
    attachments: sanitizeAttachmentsForPersistence(parseStoredJson<Message['attachments']>(row.attachments)),
    thinking: (row.thinking as string) || undefined,
    effortLevel: (row.effort_level as Message['effortLevel']) || undefined,
    contentParts: parseStoredJson<Message['contentParts']>(row.content_parts),
    metadata: parseStoredJson<Message['metadata']>(row.metadata),
    ...(row.is_meta ? { isMeta: true } : {}),
    compaction: parseStoredJson<Message['compaction']>(row.compaction),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

export function rowToSession(row: SQLiteRow): StoredSession {
  let lastTokenUsage: TokenUsage | undefined;
  if (row.last_token_usage) {
    try {
      lastTokenUsage = parseStoredJson<TokenUsage>(row.last_token_usage);
    } catch (err: unknown) {
      logger.warn('[DB] Failed to parse last_token_usage JSON:', err instanceof Error ? err.message : String(err));
    }
  }

  let workbenchProvenance: Session['workbenchProvenance'] | undefined;
  if (row.workbench_provenance) {
    try {
      workbenchProvenance = JSON.parse(row.workbench_provenance as string) as Session['workbenchProvenance'];
    } catch (err: unknown) {
      logger.warn('[DB] Failed to parse workbench_provenance JSON:', err instanceof Error ? err.message : String(err));
    }
  }

  let origin: Session['origin'] | undefined;
  if (row.origin) {
    const parsedOrigin = parseJsonObject(row.origin);
    if (typeof parsedOrigin.kind === 'string') {
      const metadata = parsedOrigin.metadata && typeof parsedOrigin.metadata === 'object' && !Array.isArray(parsedOrigin.metadata) ? (parsedOrigin.metadata as Record<string, unknown>) : undefined;
      origin = {
        kind: parsedOrigin.kind as NonNullable<Session['origin']>['kind'],
        id: typeof parsedOrigin.id === 'string' ? parsedOrigin.id : undefined,
        name: typeof parsedOrigin.name === 'string' ? parsedOrigin.name : undefined,
        metadata
      };
    }
  }

  const engine = row.agent_engine ? normalizeAgentEngineSession(parseJsonObject(row.agent_engine)) : normalizeAgentEngineSession(null);

  const isArchived = row.status === 'archived';
  const isDeleted = Boolean(row.is_deleted);

  return {
    id: row.id as string,
    userId: row.user_id == null ? null : String(row.user_id),
    title: row.title as string,
    modelConfig: {
      provider: row.model_provider as ModelProvider,
      model: row.model_name as string
    },
	    workingDirectory: row.working_directory as string | undefined,
	    type: (row.session_type as Session['type']) || 'chat',
	    origin,
	    metadata: parseStoredJson<Session['metadata']>(row.metadata),
	    parentSessionId: row.parent_session_id as string | undefined,
    sourceRunId: row.source_run_id as string | undefined,
    engine,
    memoryMode: row.memory_mode === 'off' ? 'off' : 'auto',
    suppressedMemoryEntryIds: parseJsonArray(row.suppressed_memory_entry_ids),
    readOnly: Boolean(row.read_only),
    retryOfSessionId: row.retry_of_session_id as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    messageCount: (row.message_count as number) || 0,
    turnCount: (row.turn_count as number) || 0,
    workspace: row.workspace as string | undefined,
    workbenchProvenance,
    status: (row.status as SessionStatus) || 'idle',
    lastTokenUsage,
    isArchived,
    archivedAt: isArchived ? (row.updated_at as number) : undefined,
    isDeleted,
    gitBranch: row.git_branch as string | undefined,
    projectId: (row.project_id as string) || undefined
  };
}
