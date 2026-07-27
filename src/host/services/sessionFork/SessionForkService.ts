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
  getSession(sessionId: string, options?: { userId?: string | null }): Session | null;
  createSessionFork(input: CreateForkRepositoryInput): CreateForkRepositoryResult;
  createIsolatedSessionFork?(
    input: CreateForkRepositoryInput,
  ): Promise<CreateForkRepositoryResult>;
  getSessionForkLineage(sessionId: string, ownerUserId?: string | null): SessionForkLineageSummary | null;
  listSessionForkChildren(sessionId: string, ownerUserId?: string | null): SessionForkLineageSummary[];
}

export interface SessionForkServiceOptions {
  createId?: (kind: 'fork' | 'child') => string;
  now?: () => number;
  getRuntimeStatus?: (sessionId: string) => string | undefined;
  ownerUserId?: string | null;
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
  private readonly ownerUserId: string | null | undefined;

  constructor(
    private readonly database: SessionForkServiceDatabase,
    options: SessionForkServiceOptions = {},
  ) {
    this.createId = options.createId ?? defaultCreateId;
    this.now = options.now ?? Date.now;
    this.getRuntimeStatus = options.getRuntimeStatus;
    this.ownerUserId = options.ownerUserId;
  }

  async createFork(request: CreateSessionForkRequest): Promise<CreateSessionForkResult> {
    const sourceSession = this.getOwnedSession(request.sourceSessionId);
    if (!sourceSession) {
      throw new SessionForkError('SESSION_NOT_FOUND', `source session ${request.sourceSessionId} was not found`);
    }

    const runtimeStatus = this.getRuntimeStatus?.(sourceSession.id) ?? sourceSession.status;
    if (runtimeStatus && ACTIVE_RUNTIME_STATES.has(runtimeStatus)) {
      throw new SessionForkError('SESSION_RUNNING', `source session is ${runtimeStatus}`);
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

    const repositoryInput: CreateForkRepositoryInput = {
      sourceSessionId: sourceSession.id,
      anchorAssistantMessageId: request.anchorAssistantMessageId,
      idempotencyKey: request.idempotencyKey,
      ownerUserId: this.ownerUserId,
      forkId: this.createId('fork'),
      childSessionId: this.createId('child'),
      childTitle: forkTitle(sourceSession.title),
      workspaceMode: request.workspaceMode,
      contextDeliveryMode,
      childWorkingDirectory: sourceSession.workingDirectory,
      now: this.now(),
    };
    const persisted = request.workspaceMode === 'isolated_at_anchor'
      ? await this.createIsolatedFork(repositoryInput)
      : this.database.createSessionFork(repositoryInput);
    const childSession = this.getOwnedSession(persisted.childSessionId);
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
      workspaceLabel: request.workspaceMode === 'isolated_at_anchor'
        ? '历史对话 + 锚点文件'
        : '历史对话 + 当前文件',
    };
  }

  getLineage(sessionId: string): SessionForkLineageSummary | null {
    if (this.ownerUserId === undefined) return this.database.getSessionForkLineage(sessionId);
    if (!this.getOwnedSession(sessionId)) return null;
    const lineage = this.database.getSessionForkLineage(sessionId, this.ownerUserId);
    if (!lineage || !this.getOwnedSession(lineage.parentSessionId)) return null;
    return lineage;
  }

  listChildren(sessionId: string): SessionForkLineageSummary[] {
    if (this.ownerUserId === undefined) return this.database.listSessionForkChildren(sessionId);
    if (!this.getOwnedSession(sessionId)) return [];
    return this.database
      .listSessionForkChildren(sessionId, this.ownerUserId)
      .filter((lineage) => Boolean(this.getOwnedSession(lineage.childSessionId)));
  }

  private getOwnedSession(sessionId: string): Session | null {
    return this.ownerUserId === undefined
      ? this.database.getSession(sessionId)
      : this.database.getSession(sessionId, { userId: this.ownerUserId });
  }

  private async createIsolatedFork(
    input: CreateForkRepositoryInput,
  ): Promise<CreateForkRepositoryResult> {
    if (!this.database.createIsolatedSessionFork) {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        'isolated_at_anchor requires a complete durable anchor workspace evidence service',
      );
    }
    return await this.database.createIsolatedSessionFork(input);
  }
}
