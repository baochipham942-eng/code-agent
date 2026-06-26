import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { CachedSession } from '../session/localCache';
import {
  attachEvidenceControlProjectionToReplay,
  loadEvidenceControlSummaryForSession,
} from '../session/evidenceControlSummary';
import type { StructuredReplay } from '../../shared/contract/evaluation';
import {
  buildAgentPointerTimeline,
  extractAgentPointerEvent,
} from '../../shared/utils/agentPointerEvidence';
import { attachBrowserComputerProofTimeline } from '../../shared/utils/browserComputerProofTimeline';
import type { AgentPointerEvent } from '../../shared/contract/desktop';

const logger = createLogger('TelemetryReplayEvidence');

export interface AgentPointerReplayProjection {
  agentPointerEvent?: AgentPointerEvent;
  agentPointerTimeline?: AgentPointerEvent[];
}

function normalizeMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function buildCachedSessionForEvidence(sessionId: string): CachedSession | null {
  try {
    const database = getDatabase();
    const session = database.getSession(sessionId, { includeDeleted: true });
    if (!session) return null;
    const messages = database
      .getMessages(sessionId, 500, 0, { includeRewound: true })
      .filter((message) => (
        message.role === 'user' || message.role === 'assistant' || message.role === 'system'
      ))
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant' | 'system',
        content: message.content || '',
        timestamp: message.timestamp,
        metadata: normalizeMetadataRecord(message.metadata),
      }));
    return {
      sessionId,
      messages,
      startedAt: session.createdAt,
      lastActivityAt: session.updatedAt,
      totalTokens: session.lastTokenUsage?.totalTokens || 0,
      metadata: normalizeMetadataRecord(session.metadata),
    };
  } catch (error) {
    logger.debug('Failed to build cached session for evidence control replay projection', { error, sessionId });
    return null;
  }
}

async function attachEvidenceControlSummary(replay: StructuredReplay): Promise<StructuredReplay> {
  const session = buildCachedSessionForEvidence(replay.sessionId);
  if (!session) return replay;
  try {
    const summary = await loadEvidenceControlSummaryForSession(session);
    return attachEvidenceControlProjectionToReplay(replay, summary);
  } catch (error) {
    logger.debug('Failed to attach evidence control projection to replay', {
      error,
      sessionId: replay.sessionId,
    });
    return replay;
  }
}

export function buildAgentPointerReplayProjection(resultMetadata: Record<string, unknown> | undefined): AgentPointerReplayProjection {
  const agentPointerTimeline = buildAgentPointerTimeline(resultMetadata);
  return {
    agentPointerEvent: extractAgentPointerEvent(resultMetadata) ?? undefined,
    agentPointerTimeline: agentPointerTimeline.length > 0 ? agentPointerTimeline : undefined,
  };
}

export async function attachTelemetryReplayEvidence(replay: StructuredReplay): Promise<StructuredReplay> {
  return attachEvidenceControlSummary(attachBrowserComputerProofTimeline(replay));
}
