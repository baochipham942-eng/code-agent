import { randomUUID } from 'node:crypto';

import type { Session } from '../../../shared/contract/session';
import type {
  CreateSessionForkRequest,
  CreateSessionForkResult,
  SessionForkLineageSummary,
} from '../../../shared/contract/sessionFork';
import { SessionForkError } from '../../../shared/contract/sessionFork';
import type {
  CreateForkRepositoryInput,
  CreateForkRepositoryResult,
} from '../core/repositories/SessionForkRepository';
import { getExternalForkContextCapability } from './context/externalForkContextHandoff';

const ACTIVE_RUNTIME_STATES = new Set(['running', 'paused', 'queued', 'cancelling']);

export interface SessionForkServiceDatabase {
  getSession(sessionId: string): Session | null;
  createSessionFork(input: CreateForkRepositoryInput): CreateForkRepositoryResult;
  getSessionForkLineage(sessionId: string): SessionForkLineageSummary | null;
  listSessionForkChildren(sessionId: string): SessionForkLineageSummary[];
}

export interface SessionForkServiceOptions {
  createId?: (kind: 'fork' | 'child') => string;
  now?: () => number;
  getRuntimeStatus?: (sessionId: string) => string | undefined;
}

function defaultCreateId(kind: 'fork' | 'child'): string {
  return `${kind === 'fork' ? 'fork' : 'session'}_${randomUUID()}`;
}

function forkTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || 'New Session';
  return `${base} · 分支`;
}

/**
 * The application boundary for a user-created session fork.
 *
 * The repository owns the atomic child/prefix/lineage write. This service owns
 * runtime-state validation and the context/workspace delivery decision. It
 * deliberately does not select the child or mutate any source runtime state.
 */
export class SessionForkService {
  private readonly createId: NonNullable<SessionForkServiceOptions['createId']>;
  private readonly now: NonNullable<SessionForkServiceOptions['now']>;
  private readonly getRuntimeStatus?: SessionForkServiceOptions['getRuntimeStatus'];

  constructor(
    private readonly database: SessionForkServiceDatabase,
    options: SessionForkServiceOptions = {},
  ) {
    this.createId = options.createId ?? defaultCreateId;
    this.now = options.now ?? Date.now;
    this.getRuntimeStatus = options.getRuntimeStatus;
  }

  async createFork(request: CreateSessionForkRequest): Promise<CreateSessionForkResult> {
    const sourceSession = this.database.getSession(request.sourceSessionId);
    if (!sourceSession) {
      throw new SessionForkError('SESSION_NOT_FOUND', `source session ${request.sourceSessionId} was not found`);
    }

    const runtimeStatus = this.getRuntimeStatus?.(sourceSession.id) ?? sourceSession.status;
    if (runtimeStatus && ACTIVE_RUNTIME_STATES.has(runtimeStatus)) {
      throw new SessionForkError('SESSION_RUNNING', `source session is ${runtimeStatus}`);
    }

    if (request.workspaceMode === 'isolated_at_anchor') {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        'isolated_at_anchor requires a complete anchor workspace evidence manifest',
      );
    }

    const engineKind = sourceSession.engine?.kind ?? 'native';
    let contextDeliveryMode: CreateForkRepositoryInput['contextDeliveryMode'] = 'neo_native_prefix';
    if (engineKind !== 'native') {
      const capability = getExternalForkContextCapability(engineKind);
      if (capability.deliveryMode !== 'validated_context_handoff') {
        throw new SessionForkError(
          'CONTEXT_HANDOFF_REJECTED',
          `${engineKind} cannot receive a verified fork context: ${capability.reason}`,
        );
      }
      contextDeliveryMode = 'validated_context_handoff';
    }

    const persisted = this.database.createSessionFork({
      sourceSessionId: sourceSession.id,
      anchorAssistantMessageId: request.anchorAssistantMessageId,
      idempotencyKey: request.idempotencyKey,
      forkId: this.createId('fork'),
      childSessionId: this.createId('child'),
      childTitle: forkTitle(sourceSession.title),
      workspaceMode: request.workspaceMode,
      contextDeliveryMode,
      childWorkingDirectory: sourceSession.workingDirectory,
      now: this.now(),
    });
    const childSession = this.database.getSession(persisted.childSessionId);
    if (!childSession) {
      throw new SessionForkError(
        'FORK_OPERATION_FAILED',
        `fork child ${persisted.childSessionId} was not readable after commit`,
      );
    }

    return {
      childSession,
      lineage: persisted.lineage,
      messageMappings: persisted.messageMappings,
      copiedMessageCount: persisted.copiedMessageCount,
      sourcePrefixDigest: persisted.sourcePrefixDigest,
      workspaceLabel: '历史对话 + 当前文件',
    };
  }

  getLineage(sessionId: string): SessionForkLineageSummary | null {
    return this.database.getSessionForkLineage(sessionId);
  }

  listChildren(sessionId: string): SessionForkLineageSummary[] {
    return this.database.listSessionForkChildren(sessionId);
  }
}
